import { System, Protobuf, Arrays, authority, token } from "@koinos/sdk-as";

/** entry points of the KCS-1 token standard */
export namespace TokenEntries {
  export const BALANCE_OF: u32 = 0x5c721497;
  export const TRANSFER: u32 = 0x27f576ca;
}

export namespace Contract {
  /**
   * Calls `entryPoint` of `contractId` and reverts if the call fails. The error message of the
   * callee is propagated so the original reason of a failure is not lost.
   */
  export function call(contractId: Uint8Array, entryPoint: u32, args: Uint8Array, errorMessage: string): Uint8Array {
    const res = System.call(contractId, entryPoint, args);
    if (res.code != 0) {
      let message = errorMessage;
      const err = res.res.error;
      if (err && err.message.length > 0) message = err.message;
      System.revert(message);
    }
    return res.res.object;
  }

  /**
   * Returns the identity of the account executing an operation (Uniswap's `msg.sender`).
   *
   * The arguments of the operation are given to the `authorize` entry point of a smart wallet
   * (like System.checkAccountAuthority of the Koinos SDK), so it can check what it authorizes.
   *
   * - If the operation is called by another contract, the sender is that contract, and
   *   `account` (if defined) must match it.
   * - If the operation is called directly from a transaction, the sender must be given in
   *   `account` and it has to authorize the operation (signature or smart wallet).
   *
   * This follows the `from` validation used by the KoinDX v2 periphery.
   */
  export function getSender(account: Uint8Array): Uint8Array {
    const caller = System.getCaller().caller;
    if (caller.length > 0) {
      System.require(account.length == 0 || Arrays.equal(account, caller), "KOINDX: CALLER_IS_UNAUTHORIZED");
      return caller;
    }
    System.require(account.length > 0, "KOINDX: FROM_IS_NULL");
    System.require(
      System.checkAuthority(authority.authorization_type.contract_call, account, System.getArguments().args),
      "KOINDX: UNAUTHORIZED"
    );
    return account;
  }

  /** Reverts unless `account` authorizes the current operation (see getSender) */
  export function requireAuthority(account: Uint8Array): void {
    const caller = System.getCaller().caller;
    if (caller.length > 0) {
      System.require(Arrays.equal(account, caller), "KOINDX: FORBIDDEN");
      return;
    }
    System.require(
      System.checkAuthority(authority.authorization_type.contract_call, account, System.getArguments().args),
      "KOINDX: FORBIDDEN"
    );
  }
}

/** Minimal client of a KCS-1 token */
export namespace TokenHelper {
  export function balanceOf(tokenAddress: Uint8Array, owner: Uint8Array): u64 {
    const res = Contract.call(
      tokenAddress,
      TokenEntries.BALANCE_OF,
      Protobuf.encode(new token.balance_of_arguments(owner), token.balance_of_arguments.encode),
      "KOINDX: BALANCE_OF_FAILED"
    );
    return Protobuf.decode<token.balance_of_result>(res, token.balance_of_result.decode).value;
  }

  /** TransferHelper.safeTransfer / safeTransferFrom */
  export function transfer(tokenAddress: Uint8Array, from: Uint8Array, to: Uint8Array, value: u64): void {
    Contract.call(
      tokenAddress,
      TokenEntries.TRANSFER,
      Protobuf.encode(new token.transfer_arguments(from, to, value), token.transfer_arguments.encode),
      "KOINDX: TRANSFER_FAILED"
    );
  }
}
