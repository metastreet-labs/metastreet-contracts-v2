import { BigInt } from "@graphprotocol/graph-ts";

export class FixedPoint {
  private static scale(decimals: u8): BigInt {
    return BigInt.fromU32(10).pow(decimals);
  }

  public static mul(a: BigInt, b: BigInt, decimals: u8 = 18): BigInt {
    return a.times(b).div(this.scale(decimals));
  }

  public static div(a: BigInt, b: BigInt, decimals: u8 = 18): BigInt {
    return a.times(this.scale(decimals)).div(b);
  }
}
