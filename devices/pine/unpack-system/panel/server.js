const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || "8787");
const ADB = process.env.ADB || "adb";
const ADB_SERIAL = process.env.ADB_SERIAL || "192.168.2.103:5555";
const ROOT_SU = process.env.PINE_ROOT_SU || "/debug_ramdisk/su";
const DUMP_SECONDS = Number(process.env.PINE_DUMP_SECONDS || "45");
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 512 * 1024 * 1024);
const DUMPER_CMD_TEMPLATE =
  process.env.PINE_DUMPER_CMD ||
  "/data/local/tmp/pine-run-dumper.sh --package {package} --out {out} --seconds {seconds}";

const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, "uploads");
const DOWNLOAD_DIR = path.join(ROOT, "downloads");
const DEVICE_AGENT = path.resolve(ROOT, "..", "device", "pine-run-dumper.sh");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

const jobs = [];

function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload, null, 2));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store"
  });
  res.end(body);
}

function html(res, body) {
  const payload = Buffer.from(body);
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": payload.length,
    "cache-control": "no-store"
  });
  res.end(payload);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\"'\"'")}'`;
}

function safeName(value) {
  return String(value || "app").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
}

function isValidPackageName(value) {
  return /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(String(value || ""));
}

function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs || 120000;
  const input = options.input;
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + error.message });
    });
    child.on("close", (code) => {
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (input) {
      child.stdin.end(input);
    }
  });
}

function capture(command, args, outFile, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    const sink = fs.createWriteStream(outFile);
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.stdout.pipe(sink);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      settled = true;
      clearTimeout(timer);
      sink.end();
      resolve({ code: -1, stderr: stderr + error.message });
    });
    child.on("close", (code) => {
      settled = true;
      clearTimeout(timer);
      sink.end();
      resolve({ code, stderr });
    });
  });
}

async function adb(args, options) {
  return run(ADB, ["-s", ADB_SERIAL, ...args], options);
}

async function adbShell(command, options) {
  return adb(["shell", command], options);
}

async function adbRoot(command, options) {
  return adb(["shell", ROOT_SU, "-c", command], options);
}

async function adbRootExecOut(command, outFile, timeoutMs) {
  return capture(ADB, ["-s", ADB_SERIAL, "exec-out", ROOT_SU, "-c", command], outFile, timeoutMs);
}

async function enableRomArtDexDump(job, packageName) {
  const appDumpDir = `/data/user/0/${packageName}/cache/pine-art-dumps`;
  addLog(job, "enable ROM ART dexdump before launch");
  await adbRoot(`rm -rf ${shellQuote(appDumpDir)}`, { timeoutMs: 30000 });
  await adbRoot(`setprop debug.pine.art_dexdump_pkg ${shellQuote(packageName)}`, { timeoutMs: 30000 });
  await adbRoot("setprop debug.pine.art_dexdump 1", { timeoutMs: 30000 });
}

async function disableRomArtDexDump(job) {
  addLog(job, "disable ROM ART dexdump properties");
  await adbRoot("setprop debug.pine.art_dexdump 0", { timeoutMs: 30000 });
  await adbRoot("setprop debug.pine.art_dexdump_pkg ''", { timeoutMs: 30000 });
}

function splitBuffer(buffer, delimiter) {
  const parts = [];
  let start = 0;
  let index;
  while ((index = buffer.indexOf(delimiter, start)) !== -1) {
    parts.push(buffer.subarray(start, index));
    start = index + delimiter.length;
  }
  parts.push(buffer.subarray(start));
  return parts;
}

function parseMultipart(req, body) {
  const contentType = req.headers["content-type"] || "";
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) {
    throw new Error("missing multipart boundary");
  }
  const boundary = Buffer.from(`--${match[1] || match[2]}`, "utf8");
  const fields = {};
  const files = {};
  for (let part of splitBuffer(body, boundary)) {
    if (part.length === 0) continue;
    if (part.subarray(0, 2).toString() === "\r\n") part = part.subarray(2);
    if (part.subarray(0, 2).toString() === "--") continue;
    if (part.subarray(part.length - 2).toString() === "\r\n") part = part.subarray(0, part.length - 2);
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd === -1) continue;
    const headers = part.subarray(0, headerEnd).toString("latin1");
    const content = part.subarray(headerEnd + 4);
    const disposition = headers.match(/content-disposition:[^\r\n]+/i);
    if (!disposition) continue;
    const nameMatch = disposition[0].match(/name="([^"]+)"/i);
    if (!nameMatch) continue;
    const filenameMatch = disposition[0].match(/filename="([^"]*)"/i);
    const name = nameMatch[1];
    if (filenameMatch && filenameMatch[1]) {
      files[name] = { filename: path.basename(filenameMatch[1]), content };
    } else {
      fields[name] = content.toString("utf8").trim();
    }
  }
  return { fields, files };
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        reject(new Error("upload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function detectPackage(apkPath) {
  const aapt = await run("aapt", ["dump", "badging", apkPath], { timeoutMs: 30000 });
  const badging = aapt.stdout + aapt.stderr;
  const match = badging.match(/package:\s+name='([^']+)'/);
  if (match) return match[1];
  const aapt2 = await run("aapt2", ["dump", "packagename", apkPath], { timeoutMs: 30000 });
  const packageName = aapt2.stdout.trim();
  return packageName.includes(".") ? packageName : "";
}

function addLog(job, line) {
  job.logs.push(`[${new Date().toISOString()}] ${line}`);
}

function formatDumperCommand(packageName, remoteOut) {
  return DUMPER_CMD_TEMPLATE
    .replaceAll("{package}", shellQuote(packageName))
    .replaceAll("{out}", shellQuote(remoteOut))
    .replaceAll("{seconds}", String(DUMP_SECONDS));
}

async function runJob(job, apkPath, packageName) {
  let romArtDexDumpEnabled = false;
  try {
    addLog(job, `target serial: ${ADB_SERIAL}`);
    if (ADB_SERIAL.includes(":")) {
      const connect = await run(ADB, ["connect", ADB_SERIAL], { timeoutMs: 30000 });
      addLog(job, `adb connect: ${(connect.stdout || connect.stderr).trim() || connect.code}`);
    }

    if (!packageName) {
      addLog(job, "detect package name with aapt/aapt2");
      packageName = await detectPackage(apkPath);
    }
    if (!packageName) {
      throw new Error("packageName is required when aapt/aapt2 is not available");
    }
    if (!isValidPackageName(packageName)) {
      throw new Error(`invalid packageName: ${packageName}`);
    }
    job.packageName = packageName;

    if (fs.existsSync(DEVICE_AGENT)) {
      addLog(job, "deploy device dumper wrapper");
      const push = await adb(["push", DEVICE_AGENT, "/data/local/tmp/pine-run-dumper.sh"], { timeoutMs: 60000 });
      if (push.code !== 0) throw new Error(push.stderr || push.stdout || "adb push failed");
      await adbShell("chmod 0755 /data/local/tmp/pine-run-dumper.sh", { timeoutMs: 30000 });
    }

    addLog(job, "install APK");
    const install = await adb(["install", "-r", "-g", apkPath], { timeoutMs: 180000 });
    addLog(job, (install.stdout + install.stderr).trim());
    if (install.code !== 0) throw new Error("adb install failed");

    const safePackage = safeName(packageName);
    const remoteOut = `/data/local/tmp/pine-unpack-out/${safePackage}/${job.id}`;
    job.remoteOut = remoteOut;
    addLog(job, `prepare remote out: ${remoteOut}`);
    await adbRoot(`rm -rf ${shellQuote(remoteOut)} && mkdir -p ${shellQuote(remoteOut)}`, { timeoutMs: 30000 });

    await enableRomArtDexDump(job, packageName);
    romArtDexDumpEnabled = true;

    addLog(job, "launch APK through monkey");
    await adbShell(`monkey -p ${shellQuote(packageName)} -c android.intent.category.LAUNCHER 1`, { timeoutMs: 30000 });

    addLog(job, "run dumper backend");
    const dumper = await adbRoot(formatDumperCommand(packageName, remoteOut), {
      timeoutMs: (DUMP_SECONDS + 90) * 1000
    });
    addLog(job, (dumper.stdout + dumper.stderr).trim() || `dumper exit ${dumper.code}`);
    if (dumper.code !== 0 && dumper.code !== 20) {
      addLog(job, `dumper returned ${dumper.code}; pulling diagnostics anyway`);
    }

    const archiveName = `${job.id}-${safePackage}-dex.tar.gz`;
    const archivePath = path.join(DOWNLOAD_DIR, archiveName);
    addLog(job, "pull dex archive");
    const tarCommand = `cd ${shellQuote(remoteOut)} && (toybox tar -czf - . 2>/dev/null || tar -czf - .)`;
    const pulled = await adbRootExecOut(tarCommand, archivePath, 120000);
    if (pulled.code !== 0) {
      throw new Error(`pull archive failed: ${pulled.stderr}`);
    }
    const stat = fs.statSync(archivePath);
    const sha256 = crypto.createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex");
    job.download = `/downloads/${archiveName}`;
    job.sha256 = sha256;
    addLog(job, `archive ready: ${archiveName}, ${stat.size} bytes, sha256=${sha256}`);
    job.status = "done";
  } catch (error) {
    job.status = "failed";
    addLog(job, `ERROR: ${error.message}`);
  } finally {
    if (romArtDexDumpEnabled) {
      await disableRomArtDexDump(job);
    }
  }
}

async function createJob(req, res) {
  const body = await readRequestBody(req);
  const { fields, files } = parseMultipart(req, body);
  const apk = files.apk;
  if (!apk || !apk.content || !apk.content.length) {
    json(res, 400, { error: "missing apk file" });
    return;
  }
  const id = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14) + "-" + crypto.randomBytes(4).toString("hex");
  const apkName = `${id}-${safeName(apk.filename || "upload.apk")}`;
  const apkPath = path.join(UPLOAD_DIR, apkName);
  fs.writeFileSync(apkPath, apk.content);
  const job = {
    id,
    status: "running",
    packageName: fields.packageName || "",
    apkName,
    logs: [],
    createdAt: new Date().toISOString()
  };
  jobs.unshift(job);
  jobs.splice(50);
  json(res, 202, job);
  runJob(job, apkPath, job.packageName);
}

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Redmi 7A 内部脱壳测试面板</title>
  <style>
    :root { color-scheme: light; --bg: #f8fafc; --card: #ffffff; --text: #172033; --muted: #5b6475; --line: #d9e2ef; --accent: #0f766e; --danger: #b42318; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    main { max-width: 980px; margin: 0 auto; padding: 32px 20px 48px; }
    header { display: grid; gap: 12px; margin-bottom: 22px; }
    h1 { margin: 0; font-size: 28px; letter-spacing: 0; }
    .notice { border: 1px solid #f7c8c3; background: #fff4f2; color: var(--danger); border-radius: 12px; padding: 14px 16px; font-weight: 700; }
    .grid { display: grid; grid-template-columns: 1fr; gap: 16px; }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 18px; box-shadow: 0 8px 28px rgba(15, 23, 42, 0.05); }
    label { display: block; margin: 12px 0 6px; color: var(--muted); font-size: 14px; }
    input[type="text"], input[type="file"] { width: 100%; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; background: #fff; }
    button { margin-top: 14px; border: 0; border-radius: 10px; padding: 11px 16px; background: var(--accent); color: white; font-weight: 700; cursor: pointer; }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    .hint { color: var(--muted); line-height: 1.55; }
    pre { overflow: auto; white-space: pre-wrap; background: #0f172a; color: #e5e7eb; border-radius: 12px; padding: 14px; min-height: 180px; }
    .job { border-top: 1px solid var(--line); padding: 12px 0; }
    .job:first-child { border-top: 0; }
    a { color: var(--accent); font-weight: 700; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Redmi 7A / pine 内部脱壳测试面板</h1>
      <div class="notice">仅用于内部授权测试与自有样本分析，禁止用于非法目的、未授权应用或第三方数据。</div>
      <div class="hint">默认目标 ADB：${ADB_SERIAL}。流程：上传 APK，安装到 7A，启动应用，调用设备端 dumper，然后把输出目录打包回传下载。</div>
    </header>
    <div class="grid">
      <section class="card">
        <form id="form">
          <label>APK 文件</label>
          <input id="apk" name="apk" type="file" accept=".apk,application/vnd.android.package-archive" required>
          <label>包名 packageName</label>
          <input id="packageName" name="packageName" type="text" placeholder="例如 com.example.app；本机有 aapt/aapt2 时可留空">
          <button id="submit" type="submit">上传安装并拉取 DEX</button>
        </form>
      </section>
      <section class="card">
        <h2>任务记录</h2>
        <div id="jobs" class="hint">暂无任务</div>
      </section>
      <section class="card">
        <h2>当前日志</h2>
        <pre id="log">等待任务...</pre>
      </section>
    </div>
  </main>
  <script>
    const form = document.getElementById("form");
    const submit = document.getElementById("submit");
    const jobsEl = document.getElementById("jobs");
    const logEl = document.getElementById("log");
    let activeJob = null;

    async function refreshJobs() {
      const res = await fetch("/api/jobs", { cache: "no-store" });
      const jobs = await res.json();
      if (!jobs.length) return;
      if (!activeJob) activeJob = jobs[0].id;
      jobsEl.innerHTML = jobs.map(job => {
        const link = job.download ? '<a href="' + job.download + '">下载 DEX 包</a>' : '';
        return '<div class="job"><strong>' + job.id + '</strong> ' + job.status + '<br>' +
          (job.packageName || '') + '<br>' + link + '</div>';
      }).join("");
      const job = jobs.find(item => item.id === activeJob) || jobs[0];
      logEl.textContent = job.logs.join("\\n") || "等待日志...";
      submit.disabled = jobs.some(item => item.status === "running");
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      const data = new FormData(form);
      const res = await fetch("/api/jobs", { method: "POST", body: data });
      const job = await res.json();
      activeJob = job.id;
      await refreshJobs();
    });

    setInterval(refreshJobs, 1500);
    refreshJobs();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/") {
      html(res, page());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/config") {
      json(res, 200, { adbSerial: ADB_SERIAL, rootSu: ROOT_SU, dumpSeconds: DUMP_SECONDS });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/jobs") {
      json(res, 200, jobs);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/jobs") {
      await createJob(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/downloads/")) {
      const name = path.basename(url.pathname);
      const file = path.join(DOWNLOAD_DIR, name);
      if (!fs.existsSync(file)) {
        json(res, 404, { error: "not found" });
        return;
      }
      res.writeHead(200, {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="${name}"`
      });
      fs.createReadStream(file).pipe(res);
      return;
    }
    json(res, 404, { error: "not found" });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`pine internal unpack panel: http://${HOST}:${PORT}/`);
  console.log("仅用于内部授权测试，禁止用于非法目的。");
});
