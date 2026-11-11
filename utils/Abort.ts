/**
 * Abort handler of the `DEBUG_ABORT=1` builds (see scripts/build.js): the AssemblyScript runtime
 * errors (index out of range, null dereference, failed assertion...) revert with their message
 * and source location instead of the opaque "module exited due to trap". Deployed builds use
 * `--use abort=` (plain trap).
 *
 * It can't import @koinos/sdk-as (the compiler crashes on the import cycle), so the `exit` system
 * call is encoded by hand: exit_arguments { code: 1 (reversion), res: { error: { message } } }
 */
@external("env", "invoke_system_call")
declare function invokeSystemCall(sid: u32, retPtr: u32, retLen: u32, argPtr: u32, argLen: u32, retBytes: u32): i32;

const EXIT_SYSTEM_CALL_ID: u32 = 602;
const REVERSION: u8 = 1;

function pushVarint(buffer: Array<u8>, value: u32): void {
  while (value >= 0x80) {
    buffer.push(<u8>((value & 0x7f) | 0x80));
    value >>= 7;
  }
  buffer.push(<u8>value);
}

function lengthDelimited(tag: u8, content: Array<u8>): Array<u8> {
  const buffer = new Array<u8>();
  buffer.push(tag);
  pushVarint(buffer, <u32>content.length);
  for (let i = 0; i < content.length; i++) buffer.push(content[i]);
  return buffer;
}

export function revertOnAbort(message: string | null, fileName: string | null, line: u32, column: u32): void {
  const text = "ABORT: " + (message ? message! : "") + " (" + (fileName ? fileName! : "") + ":" + line.toString() + ":" + column.toString() + ")";
  const utf8 = Uint8Array.wrap(String.UTF8.encode(text));
  const messageBytes = new Array<u8>();
  for (let i = 0; i < utf8.length; i++) messageBytes.push(utf8[i]);

  const errorData = lengthDelimited(0x0a, messageBytes); // error_data.message = 1
  const result = lengthDelimited(0x12, errorData); // result.error = 2
  const args = new Array<u8>();
  args.push(0x08); // exit_arguments.code = 1
  args.push(REVERSION);
  const res = lengthDelimited(0x12, result); // exit_arguments.res = 2
  for (let i = 0; i < res.length; i++) args.push(res[i]);

  const argsBuffer = new Uint8Array(args.length);
  for (let i = 0; i < args.length; i++) argsBuffer[i] = args[i];
  const retBuffer = new Uint8Array(16);
  const retBytes = new Uint32Array(1);
  invokeSystemCall(
    EXIT_SYSTEM_CALL_ID,
    <u32>retBuffer.dataStart,
    <u32>retBuffer.length,
    <u32>argsBuffer.dataStart,
    <u32>argsBuffer.length,
    <u32>retBytes.dataStart
  );
}
