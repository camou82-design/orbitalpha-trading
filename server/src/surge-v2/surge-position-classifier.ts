export function isSurgePosition(pos: any): boolean {
  return (
    pos.engine_bucket === "surge" ||
    pos.signal_strength === "SURGE_SCANNER" ||
    pos.reason_enter?.includes("surge")
  );
}
