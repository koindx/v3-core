export namespace Spaces {
  export const OWNER_SPACE_ID = 0;
  // fee (4 bytes big endian) => fee_record
  export const FEE_AMOUNTS_SPACE_ID = 1;
  // token0 + 0x00 + token1 + 0x00 + fee (4 bytes) => pool_info
  export const POOLS_SPACE_ID = 2;
  // index (8 bytes big endian) => pool_info
  export const POOL_LIST_SPACE_ID = 3;
  export const POOL_COUNT_SPACE_ID = 4;
  // the owner proposed by set_owner, until it calls accept_owner
  export const PENDING_OWNER_SPACE_ID = 5;
  // token address => bool_value: tokens without allowances, exempt from the allowance check of
  // create_pool (set_allowances_exempt)
  export const ALLOWANCES_EXEMPT_SPACE_ID = 6;
}
