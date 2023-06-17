import { Bytes, ethereum } from "@graphprotocol/graph-ts";

export function decodeLogData(types: string, log: ethereum.Log): ethereum.Tuple | null {
  let encodedLogData = Bytes.fromHexString("0x");
  for (let i = 1; i < log.topics.length; i++) encodedLogData = encodedLogData.concat(log.topics[i]);
  encodedLogData = encodedLogData.concat(log.data);

  const decodedLogData = ethereum.decode(types, encodedLogData);
  if (decodedLogData) return decodedLogData.toTuple();
  return null;
}
