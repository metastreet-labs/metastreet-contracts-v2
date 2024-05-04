import { BigInt } from "@graphprotocol/graph-ts";

export class FixedPoint {
  public static DECIMALS: u8 = 18;

  private static scale(decimals: u8): BigInt {
    return BigInt.fromU32(10).pow(decimals);
  }

  public static scaleUp(n: BigInt, decimals: u8): BigInt {
    return n.times(this.scale(decimals));
  }

  public static scaleDown(n: BigInt, decimals: u8): BigInt {
    return n.div(this.scale(decimals));
  }

  public static mul(a: BigInt, b: BigInt, decimals: u8 = this.DECIMALS): BigInt {
    return this.scaleDown(a.times(b), decimals);
  }

  public static div(a: BigInt, b: BigInt, decimals: u8 = this.DECIMALS): BigInt {
    return this.scaleUp(a, decimals).div(b);
  }
}
