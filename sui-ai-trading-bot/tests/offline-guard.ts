// Reject socket creation before any test transport can reach a real endpoint.
import { Socket, Server } from "node:net";
import { syncBuiltinESMExports } from "node:module";
const forbidden = () => {
  throw Error("OFFLINE_NETWORK_FORBIDDEN");
};
Socket.prototype.connect = forbidden as typeof Socket.prototype.connect;
Server.prototype.listen = forbidden as typeof Server.prototype.listen;
syncBuiltinESMExports();
