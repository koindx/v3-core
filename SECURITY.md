# Security review

This review covers the three KoinDX v3 repositories: [v3-core](https://github.com/koindx/v3-core) (this one),
[v3-periphery](https://github.com/koindx/v3-periphery) and [v3-integration-tests](https://github.com/koindx/v3-integration-tests).
A path that starts with a repository name (`v3-periphery/...`) is in that repository.

It checks that the KoinDX v3 contracts behave like Uniswap v3, and looks for attacks
that are specific to Koinos (they don't exist on Ethereum, so Uniswap's audits and tests don't
cover them). It is an internal review backed by tests, not a substitute for an independent audit:
see [Recommendations](#recommendations).

It was done in three rounds: a first review (findings F1 to F4), then an adversarial review of
the code written for KoinDX (the 256-bit math, the storage layout, the pool creation by the
factory, the periphery authorization, and the pool compared line by line with `UniswapV3Pool.sol`)
by independent AI reviewers without the context of the authors, with the Uniswap and koinos-chain
sources, each finding proven by a test (findings F5 to F10), and a final review of the whole code
before the publication (core and periphery compared function by function with the Uniswap
sources, findings F11 to F13).

## Equivalence with Uniswap v3

| Evidence | What it compares | Result |
|---|---|---|
| Uniswap v3-core test suites ported ([v3-core/docs/UNISWAP_TESTS.md](docs/UNISWAP_TESTS.md)) | the compiled pool and factory in a Koinos VM emulator, with the expected values and snapshots of Uniswap | all pass |
| Uniswap v3-periphery test suites ported ([v3-periphery/docs/UNISWAP_TESTS.md](https://github.com/koindx/v3-periphery/blob/main/docs/UNISWAP_TESTS.md)) | manager, router and quoter with the v3-core pools | all pass |
| differential fuzzers (`differential/Pool.fuzz.test.js`, `differential/Periphery.fuzz.test.js`) | random sequences of mints, burns, collects, swaps, flash loans, protocol fees and router / manager operations, on KoinDX and on the Uniswap v3 bytecode deployed on Ethereum (run in an EVM), compared after every operation (amounts, errors, prices, ticks, liquidity, fee growth, positions, balances) | identical, including large batches with new seeds (`POOL_FUZZ_RUNS`, `PERIPHERY_FUZZ_RUNS`) |
| 256-bit math (`tests/math.test.js`, `tests/as-bignum.test.js`, [OVERFLOW.md](docs/OVERFLOW.md)) | `U256`, `FullMath`, `TickMath`, `SqrtPriceMath`, `SwapMath` against a BigInt transliteration of the Solidity code, `@uniswap/v3-sdk` and the audited as-bignum vectors | identical |
| edge cases (`differential/PoolEdges.test.js`) | the regions the random fuzzer rarely reaches (MIN/MAX ticks and prices, swaps ending on ticks, maxLiquidityPerTick, oracle and 32-bit time wrap-around, fee growth wrapping), on KoinDX and on the Uniswap bytecode, and `quote_swap` against each swap | identical |
| independent math review | ~39.5M differential checks of the math against a new transliteration of the Solidity code (FullMath's own algorithm, every tick of TickMath, constructed add-back cases of the Knuth division), all the TickMath constants, and mutation testing (56 mutants of the math: the 13 that the tests don't kill are equivalent on the reachable inputs, and the 2 test gaps were closed) | identical on every reachable input (finding F10) |
| integration tests ([v3-integration-tests](https://github.com/koindx/v3-integration-tests)) | the release builds on a local Koinos node (koinos-chain 1.0.2) with a KCS-4 token built from `Koin.ts`, against `@uniswap/v3-sdk` | all pass |

The only intended differences are the ones of the Koinos token standard: token amounts are `u64`
(an operation that would need more than 2^64 - 1 units reverts with `AMOUNT_OVERFLOW` instead of
succeeding), and the swaps take a direction and a `u64` amount instead of a signed `int256`.

## Koinos threat model

| Attack | Protection | Tests |
|---|---|---|
| The account that uploads a pool (anybody can) keeps its key: it could move the tokens of the pool, upgrade its code or act as the pool | the factory only registers a pool whose upload in the same transaction overrides the 3 authorities (`call_contract`, `transaction_application`, `upload_contract`) and whose bytecode hash is the KoinDX pool; the pool's `authorize` always returns false | `v3-core/tests/koinos-security.test.js` |
| The pool address has a history (unlike a CREATE2 address): code uploaded there before, records it wrote in the storage, allowances on the pool tokens granted with its key | `create_pool` must be an operation of the transaction that comes after the upload, so `configure` runs the pool code (finding F11), which requires an empty storage; the pool must have no allowances on its two tokens (`get_allowances`, finding F12) | `v3-core/tests/koinos-security.test.js`, integration tests `pool creation` and `reentrancy from a smart wallet` |
| The same for the keys of the factory, manager, router and quoter | the deployment scripts override their authorities; their `authorize` returns false | `v3-periphery/tests/koinos-security.test.js` (manager, router) |
| Spending the allowance that a user gave to the router or the manager (KCS-4 `approve`) | every operation has a payer `from`: a calling contract must be `from`, a transaction must be authorized by `from` (`Contract.getSender`) | `v3-periphery/tests/koinos-security.test.js`, `kcs4.test.js` |
| Burning or collecting the position of another account when calling the pool directly | the position is the one of the calling contract, or of `owner`, who must authorize the transaction | `v3-core/tests/koinos-security.test.js` |
| Fake callbacks (a contract that calls `koindx_v3_swap_callback` of the router to pull tokens) | the router and the manager only accept callbacks from the pool that the factory registered for the tokens and fee of the callback data | `CallbackValidation.test.js`, integration tests |
| Reentrancy (a token or callback that calls the pool again) | the `unlocked` flag of Uniswap (`KOINDX: LOCKED`); reverts unwind the whole transaction | `UniswapV3Pool.test.js`, `TestUniswapV3ReentrantCallee` |
| Code that runs during an authority check or a "view" call: the `authorize` of a smart wallet runs when its authority is checked, and every call is writable (no `staticcall`: a token `balance_of` can call back) | the pool saves `unlocked = false` before any call to another contract, or loads its state after the authority check; the manager reads the token owner and the position again after such calls (finding F5 to F8) | `koinos-security.test.js` (core and periphery), and on a real Koinos node with a smart wallet that re-enters (integration tests `reentrancy from a smart wallet`), including the attack succeeding on the pool before the fix |
| Paying a pool less than owed | balances checked after the callback, like Uniswap (`IIA`, `M0`/`M1`, `F0`/`F1`) | Uniswap tests, `koinos-security.test.js` |
| A token that returns without transferring (KCS-1 tokens returned `false`) | payouts check the balance of the pool (`TRANSFER_FAILED`, Uniswap: `TF`) | `koinos-security.test.js` |
| Reconfiguring a pool (tokens, fee) | `configure` only works on a fresh pool (empty storage) and the calling contract becomes its factory: the factory configures it in the creation transaction, and a pool configured by another contract is never registered | `koinos-security.test.js` |
| Two pools for the same pair (lenient base58 identifiers, `koin` by name and by address) | canonical identifiers only (finding F1), system tokens only by name | `UniswapV3Factory.test.js`, `koinos-security.test.js` |
| Malformed addresses (`bytes` of any length are valid in the ABI) | recipients of 25 bytes (finding F2) | `koinos-security.test.js` (core and periphery) |
| A smart wallet that authorizes by policy (e.g. "only swaps to myself") | the operation arguments are passed to its `authorize` (finding F4) | `v3-periphery/tests/koinos-security.test.js` |
| Integer overflow | checked 256-bit math (wrapping only where Solidity relies on it), `SafeCast` to `u64`, strict parsing of decimal strings | [OVERFLOW.md](docs/OVERFLOW.md), `overflow.test.js` |
| Memory corruption by the AssemblyScript GC | `stub` runtime (no GC, memory released at the end of the call) | the whole test suite on the release builds |
| A token whose creator replaces its code (on Koinos the key of a contract account can upload new code unless it gave up that power): a `balance_of` that lies makes a pool pay out the other token without being paid | none in the contracts (no contract can defend itself against its own tokens, like Uniswap with upgradeable tokens such as USDC): the interfaces check each token against a reviewed token list, with the hash of the reviewed code, and its metadata on the chain; they warn before a deposit or a swap with an unreviewed token and block a reviewed token whose code changed ([token checks](#token-checks-for-interfaces)) | integration tests `token checks (interfaces)` |
| Mana / resource exhaustion by a pool | a pool can't be the payer of a transaction (its `authorize` says no); users pay their own mana | — |

## Findings

All the findings are fixed, with tests.

| # | Finding | Impact | Fix |
|---|---|---|---|
| F1 | The base58 decoder of the SDK is lenient: it skips spaces and extra leading `1`, and stops at the first invalid character. `"<address> "` decoded to the same address as `"<address>"` | several pools for the same tokens and fee (liquidity split, routing to an unexpected pool) | `Tokens.address` accepts only the canonical encoding of a 25 byte address (`KOINDX: INVALID_TOKEN`) |
| F2 | A recipient of any length was accepted (`bytes` in the ABI) | tokens sent to an address nobody controls (a typo in a frontend), positions owned by an invalid account | recipients must be 25 bytes in the pool (`mint`, `collect`, `swap`, `flash`, `collect_protocol`), the router and the manager (`KOINDX: INVALID_RECIPIENT`) |
| F3 | The payouts of the pool trusted the token: a token that returns without transferring (e.g. while paused) left the pool accounting as if paid | positions or swaps marked as paid without tokens | `transferOut` checks that the balance of the pool decreased by the amount (`KOINDX: TRANSFER_FAILED`, Uniswap: `TF`) |
| F4 | `System.checkAuthority` was called without the operation arguments | a smart wallet with a policy on the arguments (recipient, amounts) couldn't enforce it | the arguments of the call are passed to `checkAuthority` (payer checks, position owner checks, manager transfers) |
| F5 | **Critical.** The pool loaded its state, then checked the authority of `owner` in `burn` / `collect` (the `authorize` of a smart wallet runs there, with the pool still unlocked), then saved the state loaded before. The same in `flash` (token balances read before saving the lock) and in `set_fee_protocol` / `collect_protocol` (authority of the factory owner) | anybody (a smart wallet owning a position) could swap during its `authorize` and have the price, tick, liquidity and fee growth of the pool reset to their values before the swap while the tokens had moved: corrupted accounting, loss of LP funds | `burn` / `collect` check the authority before loading the state; `flash`, `set_fee_protocol` and `collect_protocol` save the lock before any call to another contract (Uniswap's `lock` order): a reentry reverts with `LOCKED` |
| F6 | Manager `approve` read the owner of the token before the authority check of the approver | an approval stored on a token that its approver had transferred during the check (an escrow receives a token that carries an approval of its previous owner) | the authority check first, then the owner; the approved address must be 25 bytes (or empty to clear) |
| F7 | Manager `transfer` used the owner read before the authority check of the owner | the owner index and balances of the NFTs inconsistent with `owner_of` | the owner must still be the same after the authority check (`FROM_IS_NOT_OWNER`) |
| F8 | Manager `increase_liquidity` saved the position read before the payment (the payment can run the `authorize` of the payer) | a burned NFT re-created with liquidity that can't be withdrawn (only by the owner itself) | the position is read again after the payment (Uniswap: storage pointer) |
| F9 | The router accepted itself as the recipient of a swap | tokens left in the router, where anybody can take them with `sweep_token` | `KOINDX: INVALID_RECIPIENT` |
| F10 | `TickMath.getSqrtRatioAtTick(-2^31)` returned the price of tick 0: the absolute value of the i32 minimum overflows (Solidity takes an int24) | none today (the pool checks the ticks before, the manager's mint then reverts in the pool), a trap for future callers | the range is checked before the absolute value |
| F11 | **Critical.** `create_pool` checked that the transaction uploads the pool bytecode, not that the upload was applied when it calls `configure`. With `create_pool` before the upload, or called from the `authorize` of the previous code of the address (Koinos runs it to check the upload, before storing the new code), `configure` ran the previous code of the pool address, which could write any record in the pool storage (e.g. a position owed all the tokens of the pool); the pool code uploaded next keeps that storage | the creator of a pool takes all the tokens that liquidity providers deposit in it | `create_pool` must be an operation of the transaction, not a call from a contract (`CREATE_POOL_MUST_BE_AN_OPERATION`), and the upload must come before every call to the factory in the transaction (`POOL_UPLOAD_MUST_COME_FIRST`): `configure` runs the pool code, which rejects a storage that isn't empty. A contract can no longer create pools (the manager initializes them) |
| F12 | **Critical.** KCS-4 allowances granted with the key of the pool address before the upload (in an earlier transaction, or earlier in the creation transaction) survive the upload, and the token lets a spender move the tokens of the pool up to its allowance without the authority of the pool (the overrides only stop new authority checks). This works with an honest token, KOIN included | the creator of a pool takes all the tokens of the pool | `create_pool` reads the allowances of the pool on its two tokens (KCS-4 `get_allowances`, every page) and reverts if there is any (`POOL_HAS_ALLOWANCES`). On Koinos a contract can't try an entry point (an unknown one reverts the whole transaction), so a token without allowances (no `approve`, e.g. KCS-1) can only have pools once the factory owner exempts it (`set_allowances_exempt`) |
| F13 | The quoter returned a quote of 0 for a swap entirely within a region without liquidity, where Uniswap's QuoterV2 and the router revert | an interface shows "0 out" instead of an error; no funds at risk | the quoter reverts with `INVALID_SWAP_DELTAS`, like the router (`differential/QuoterEdges.test.js` compares it with the QuoterV2 bytecode) |
| — | Informational: `tick_bitmap` and `observations` truncated their index to 16 bits; `get_populated_ticks` didn't document that `start` is excluded; the overflow check of `U256.shl` overflowed for shifts near 2^31 (only constant shifts are used); misleading comments | wrong answers of views | range checks like Uniswap (`INVALID_WORD_POSITION`, `INVALID_INDEX`), `n <= 256 - bitLength`, documentation |

## Limits

| Limit | Value | Consequence |
|---|---|---|
| memory per contract call | 32 MiB (512 pages) | a swap can cross about **4600 initialized ticks** in one call (~7 KiB each); more reverts with no state change. Like the block gas limit on Ethereum, a swap through a very dense region must be split (price limit or smaller amounts) |
| swap through an empty region of the tick bitmap | ~26k compute per bitmap word | the whole price range of a tick spacing 1 pool (3465 words, 16 MiB) succeeds in one transaction (integration test `limits`) |
| read-only calls | lower compute limit | the quoter can't simulate extreme swaps through empty ranges; the swaps themselves work |
| token amounts | `u64` | the reserves of a pool can't exceed 2^64 - 1 units of each token (`AMOUNT_OVERFLOW`) |

## Koinos node version

The integration tests run on `koinos-chain` v1.0.2 (the version bundled by `@roamin/local-koinos`),
while the Koinos mainnet runs v1.5.2. A local dev node for v1.5.2 is not available (it would need a
custom genesis with dev consensus and pre-provisioned mana, and the dev tooling is unmaintained),
so the two versions were compared **at the source level**, for the system calls the contracts use
(`check_authority`, `call`, `get_caller`, the object storage calls, the name service, revert / error
codes, the thunk ids and the `authorization_type` enum):

- **No change affects the contracts' behavior.** The only contract-facing change is that
  `check_authority` in v1.5.2 derives the authorization type from the call context instead of
  trusting the passed value (`src/koinos/chain/system_calls.cpp`, commit 938ac90d). It is
  equivalent for KoinDX, which only ever calls `checkAuthority` with `contract_call` from contract
  code, exactly the value v1.5.2 derives in that case. The writable, re-entrant `authorize` call
  that finding F5 addresses is unchanged, so the fix stays necessary and sufficient. The nested
  call, storage, caller and revert semantics are byte-identical; no thunk id was renumbered or
  removed; the `authorization_type` enum is unchanged.
- **The limits above don't change with the version.** The per-syscall compute costs come from the
  chain state (the compute bandwidth registry), not from the node binary, and the hot-path syscalls
  (`check_authority`, `call`, `get_object` / `put_object` / `get_next_object`) charge the same in
  both versions.
- This is a code comparison, not an execution on v1.5.2: confirm on the Koinos testnet (harbinger,
  which runs the mainnet version) before mainnet, see [Recommendations](#recommendations).

## Trust assumptions

- **Immutable contracts (deliberate, like Uniswap v3)**: the factory, the pools, the manager, the
  router and the quoter give up the authority to upload new code when they are deployed (the deploy
  scripts override `upload_contract`, and each contract's `authorize` returns false), so **nobody,
  the team included, can change their code, pause them or touch the funds in them**. This is the
  same guarantee as Uniswap v3 and the reason a DEX can be trusted without trusting its authors.
  Its cost is that there is no pause and no upgrade: if a bug is found after launch, or a listed
  token turns malicious, the only remedy is to deploy new contracts and have liquidity providers
  move their liquidity. What protects users in the meantime is that **withdrawing liquidity never
  needs anyone's permission** (`decrease_liquidity` + `collect`, or the pool's `burn` + `collect`,
  are always available to the position's owner), the [token checks](#token-checks-for-interfaces)
  that warn before a deposit, and an audit and a gradual launch before mainnet (see
  [Recommendations](#recommendations)). The immutability is verified on a real node (integration
  test `the deployed contracts are immutable`).
- **Factory owner**: enables fee tiers, sets the protocol fee (0 or 1/4 to 1/10 of the swap fees)
  and collects it, like Uniswap's owner. It can't touch the liquidity or the swaps, nor the code.
  It should be a multisig or governance contract. Unlike Uniswap, the ownership is transferred in
  two steps: `set_owner` proposes the new owner and the new owner calls `accept_owner`, so a
  proposal to an account that can't sign (a typo) doesn't lock the owner functions. Both read
  the owner or the proposal again after the authority check (a smart wallet runs code there), so
  an ownership change made during it makes the call revert (`koinos-security.test.js`).
  The owner also keeps the list of tokens exempt from the allowance check of `create_pool`
  (`set_allowances_exempt`, finding F12): it must only exempt tokens that have no allowances at
  all (no `approve`), since the pools of an exempt token can be created with allowances of the pool
  address. The exemptions are public (`allowances_exempt`, `factory.allowances_exempt_event`).
- **Pool configuration**: `configure` trusts the first contract that calls it on a fresh pool as
  its factory. The factory only registers a pool that it configured itself in the creation
  transaction, and the router and the manager only use registered pools, so a pool configured by
  another contract is never used.
- **Name service**: `"koin"` and `"vhp"` are resolved through the Koinos name service at each
  call, like KoinDX v2, so a pool follows the system token if governance moves it (the previous
  address could then get its own pools as a regular token). This is deliberate.
- **Tokens**: KCS-4 tokens that transfer exactly the amount requested. Fee-on-transfer, rebasing
  or tokens with callbacks that misbehave are not supported (like Uniswap v3); a token that delivers
  less than the amount to a pool makes the operation revert. A malicious token can empty the pools
  that contain it, and on Koinos a token can become malicious after people deposited (its creator
  replaces its code): see [token checks](#token-checks-for-interfaces).
- **Pool initialization**: the first account to initialize a pool sets its price, like Uniswap;
  use `initialize_pool_if_necessary` in the same transaction as the first mint.
- **Frontends**: build the 64-bit integers with `long.js` in the browser (otherwise values above
  2^53 are encoded wrongly), approve the exact amounts in the same transaction, and use
  `amount_out_minimum` / `amount_in_maximum` and deadlines against front-running, like on Uniswap.
  The deadline is mandatory, like Uniswap (0 reverts), in milliseconds: a Koinos transaction has no
  expiration, so a signed transaction could otherwise be included much later. Like Uniswap, a
  multi hop `exact_input` whose later hop is only partly filled leaves the rest of the intermediate
  token in the router, where anybody can take it with `sweep_token` (Uniswap: `sweepToken`):
  `amount_out_minimum` prevents it.
- **KOIN mana**: a KOIN transfer needs mana ≥ the amount (`Koin.ts`) and the transaction is paid
  with mana too, so an account can't send all its KOIN. Interfaces limit the KOIN amounts to
  min(balance, mana) minus the transaction's RC and explain it (the playground does). Read the mana
  from the KOIN contract (`get_account_rc` entry point of `Koin.ts`): `chain.get_account_rc` only
  returns it where KOIN overrides that system call, otherwise a fixed cap (`max_account_resources`).
- **Signatures**: an account that signs a transaction (e.g. to pay its mana) authorizes every
  operation of it that uses its authority, like any Koinos contract (KOIN too): check the
  operations before co-signing.
- **NFT approvals**: an account approved for a position can decrease and collect it to any
  recipient, like Uniswap: an approval is full control of the position.

## Token checks for interfaces

On Koinos the account of a contract keeps the power to upload new code to it, unless it overrides
its `upload_contract` authority (as the KoinDX contracts do). Most tokens keep it: their creator can
replace a token at any time, for example with a `balance_of` that lies, and the pools that contain
it pay out the other token without being paid. The pools can't detect it (they can only ask the
token itself), so the protection is in the interfaces, like the token lists of Uniswap:

- a **reviewed token list** (format of `v3-integration-tests/playground/server.js`, `tokenList`): the
  identifier of each token, and the hash of the code that was reviewed (`0x1220` + sha256 of the
  wasm, as in the contract metadata). To be listed, a token should have given up the upload power
  (authority override of `upload_contract` and an `authorize` that never allows an upload), or have
  an issuer that the list maintainers trust; its `transfer` and `balance_of` are reviewed;
- the **contract metadata** on the chain (`get_contract_metadata`: code hash, authority overrides,
  system contract), read by [`v3-integration-tests/frontend/token-check.js`](https://github.com/koindx/v3-integration-tests/blob/main/frontend/token-check.js)
  through `chain.invoke_system_call` (koinos-chain >= 1.2) or the contract of the system call;
- the interface **warns** before a deposit or a swap with an unreviewed token, and **blocks** a
  reviewed token whose code changed since its review (withdrawals stay available). The playground
  shows it, with a button that replaces the code of a test token.

This only protects the users who haven't deposited yet: an upgrade of a reviewed token is detected
at the next check, not prevented.

## Recommendations

1. The most valuable next review is of the code written for KoinDX, which no Uniswap audit
   covers: the AssemblyScript math (`U256`, `FullMath`), the storage layout, the factory upload
   checks, the authorization of the periphery (`utils/Contract.ts`) and every place where a call
   to another contract can run code (F5 to F8). An independent professional audit is the
   reference; without budget, a review by people of the Koinos ecosystem and by other AI models
   (a different model sees different things) still adds independent eyes. Give the reviewers
   this document so they start from what is already covered.
2. A deployment on the Koinos testnet (harbinger) with real wallets (including smart wallets)
   and frontends, then a gradual launch on mainnet (small pools first), and a bug bounty (it can
   be paid from the protocol fees). On harbinger, check that the KOIN and VHP contracts answer
   `get_allowances` (otherwise their pools need `set_allowances_exempt`, only if they have no
   allowances) and that the pool creation checks of F11 and F12 behave as on the local node.
3. Run the large fuzz batches again after any change to the contracts:
   `POOL_FUZZ_RUNS=200 POOL_FUZZ_OPS=100 POOL_FUZZ_SEED=<n> yarn test differential/Pool` (v3-core) and
   `PERIPHERY_FUZZ_RUNS=200 PERIPHERY_FUZZ_OPS=100 PERIPHERY_FUZZ_SEED=<n> yarn test differential` (v3-periphery).
4. For any new code: never keep a state read before a call to another contract (an authority
   check included) and save it after; save `unlocked = false` before such calls, or read again.
