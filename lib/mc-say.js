/**
 * 让她的身体说一句话（MC 公屏），不经过模型。
 *
 * 用途：意图闸门拦下"让她干活"的请求后，由插件直接回一句状态化的拒绝——零 token。
 * 走模组的控制层协议（TCP 一行 JSON），不读任何本地文件。
 */

import net from "node:net";

/**
 * @param params.text 要说的话（会自动截断到 200 字，公屏有长度限制）
 * @param params.host 默认 127.0.0.1
 * @param params.port 默认 8765（模组控制层）
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export function sayInGame(params = {}) {
  const text = String(params.text ?? "").slice(0, 200).trim();
  if (!text) return Promise.resolve({ ok: false, error: "text 为空" });
  const host = params.host || "127.0.0.1";
  const port = Number(params.port ?? 8765);
  const timeoutMs = Number(params.timeoutMs ?? 3000);

  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    const sock = net.createConnection({ host, port }, () => {
      sock.write(`${JSON.stringify({ v: 1, rid: Date.now() % 100000, action: "chat", text })}\n`);
    });
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      finish({ ok: false, error: "timeout" });
    }, timeoutMs);
    timer.unref?.();
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (buf.includes("\n")) {
        clearTimeout(timer);
        sock.end();
        finish({ ok: true });
      }
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      finish({ ok: false, error: e instanceof Error ? e.message : String(e) });
    });
  });
}
