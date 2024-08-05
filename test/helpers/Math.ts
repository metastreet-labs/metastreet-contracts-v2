export class BigIntMath {
  static abs(x: bigint): bigint {
    return x < 0n ? -x : x;
  }
}
