import { useEffect, useState } from "react";
import { getConnection, subscribeConnection, type Connection } from "./connection.js";

/** The shared connection state (see connection.ts). */
export function useConnection(): Connection {
  const [c, setC] = useState(getConnection());
  useEffect(() => {
    const sync = () => setC(getConnection());
    sync();
    return subscribeConnection(sync);
  }, []);
  return c;
}
