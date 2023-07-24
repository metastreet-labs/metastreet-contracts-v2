import { BigInt, Bytes } from "@graphprotocol/graph-ts";

export function bytesFromBigInt(bigInt: BigInt): Bytes {
  return Bytes.fromByteArray(Bytes.fromBigInt(bigInt));
}
