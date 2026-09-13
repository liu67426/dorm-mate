import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path, { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// 零依赖静态服务器:替代 `python -m http.server`,Node 20+ 即可,无需安装 Python。
// 用法:npm run serve(默认 8770 端口);换端口:PORT=8771 npm run serve
const rootDir = resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 8770);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon"
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("400 请求路径无法解析");
      return;
    }
    if (pathname.endsWith("/")) pathname += "index.html";
    // 目录列表不需要,但 /student/、/admin/ 这类目录入口要落到各自的 index.html。
    const filePath = normalize(join(rootDir, pathname));
    if (filePath !== rootDir && !filePath.startsWith(rootDir + sep)) {
      response.writeHead(403).end("禁止访问");
      return;
    }
    const target = filePath.endsWith(sep) ? join(filePath, "index.html") : filePath;
    const stats = await stat(target).catch(() => null);
    const finalPath = stats?.isDirectory() ? join(target, "index.html") : target;
    const body = await readFile(finalPath);
    response.writeHead(200, { "Content-Type": MIME_TYPES[extname(finalPath).toLowerCase()] || "application/octet-stream" });
    response.end(body);
  } catch (error) {
    if (error?.code === "ENOENT") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("404 没有这个页面");
      return;
    }
    response.writeHead(500).end("服务器内部错误");
  }
});

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE" || error?.code === "EACCES") {
    console.error(`✖ 端口 ${port} 被占用:很可能是之前的服务没关干净。请关闭旧的终端窗口后重试,或换一个端口启动:PORT=8771 npm run serve`);
    process.exit(1);
  }
  throw error;
});

server.listen(port, "127.0.0.1", () => {
  console.log(`本地演示已启动: http://127.0.0.1:${port}/`);
  console.log(`学生端: http://127.0.0.1:${port}/student/   辅导员端: http://127.0.0.1:${port}/admin/`);
  console.log("按 Ctrl+C 停止。演示数据只保存在浏览器里。");
});
