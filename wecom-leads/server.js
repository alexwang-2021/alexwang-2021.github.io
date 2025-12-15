import cookieSession from "cookie-session";

const CORP_ID = "wwe577d12d1d46f55a";
const AGENT_ID = "1000008";
const APP_SECRET = "zbUCznOCOlatTWOIZg8krInaNtPXHpZNsyiBI_3Kmd8";
const BASE_URL = "http://localhost:3000"; // 本地调试可先用 http://localhost:3000

app.use(cookieSession({
  name: "sess",
  keys: ["a-long-random-key"],
  maxAge: 7 * 24 * 60 * 60 * 1000
}));

import express from "express";
import Database from "better-sqlite3";
import cron from "node-cron";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ====== 配置：把这里换成你的企业微信群机器人 Webhook ======
const WEWORK_WEBHOOK = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=365d64c1-29a0-4912-9d47-62aed4f69801";

// ---- DB ----
const db = new Database("leads.db");
db.exec(`
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_name TEXT NOT NULL,
  staff_wecom_userid TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_phone TEXT,
  customer_wecom_id TEXT,
  note TEXT,
  next_follow_at TEXT NOT NULL, -- ISO string
  status TEXT NOT NULL DEFAULT 'pending', -- pending/done
  created_at TEXT NOT NULL
);
`);

const insertLead = db.prepare(`
INSERT INTO leads (
  staff_name, staff_wecom_userid, customer_name, customer_phone, customer_wecom_id,
  note, next_follow_at, status, created_at
) VALUES (
  @staff_name, @staff_wecom_userid, @customer_name, @customer_phone, @customer_wecom_id,
  @note, @next_follow_at, 'pending', @created_at
);
`);

const dueLeads = db.prepare(`
SELECT * FROM leads
WHERE status='pending' AND datetime(next_follow_at) <= datetime('now','+8 hours')
ORDER BY datetime(next_follow_at) ASC
LIMIT ?
`);

const markDone = db.prepare(`UPDATE leads SET status='done' WHERE id=?`);

// ---- 简单上传页面 ----
app.get("/", (req, res) => {
  res.type("html").send(`
<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>企微线索上传</title>
  <style>
    body{font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", Arial; padding:18px; max-width:720px; margin:auto;}
    input, textarea{width:100%; padding:10px; margin:8px 0; box-sizing:border-box;}
    button{padding:10px 14px;}
    .row{display:grid; grid-template-columns:1fr 1fr; gap:10px;}
  </style>
</head>
<body>
  <h2>员工上传企业微信线索</h2>
  <form method="post" action="/api/leads">
    <div class="row">
      <input name="staff_name" placeholder="员工姓名(必填)" required />
      <input name="staff_wecom_userid" placeholder="员工企微 userid(必填)" required />
    </div>
    <div class="row">
      <input name="customer_name" placeholder="客户姓名(必填)" required />
      <input name="customer_phone" placeholder="客户手机号(可选)" />
    </div>
    <input name="customer_wecom_id" placeholder="客户企微ID/外部联系人标识(可选)" />
    <textarea name="note" placeholder="备注(可选)"></textarea>
    <label>下次跟进时间（例如 2025-12-14 18:30）</label>
    <input name="next_follow_at" placeholder="YYYY-MM-DD HH:mm" required />
    <button type="submit">提交</button>
  </form>
  <hr/>
  <p>提交后会入库，并由定时任务扫描到期线索。</p>
  <p>手动触发日报：<a href="/report/daily" target="_blank">/report/daily</a></p>
</body>
</html>
  `);
});

// ---- API: 创建线索 ----
app.post("/api/leads", (req, res) => {
  try {
    const {
      staff_name,
      staff_wecom_userid,
      customer_name,
      customer_phone = "",
      customer_wecom_id = "",
      note = "",
      next_follow_at
    } = req.body;

    const iso = toISO8(next_follow_at);

    insertLead.run({
      staff_name,
      staff_wecom_userid,
      customer_name,
      customer_phone,
      customer_wecom_id,
      note,
      next_follow_at: iso,
      created_at: new Date().toISOString()
    });

    res.redirect("/");
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e) });
  }
});

// ---- API: 查看待跟进线索 ----
app.get("/api/leads/due", (req, res) => {
  const limit = Number(req.query.limit || 20);
  const rows = dueLeads.all(limit);
  res.json({ ok: true, rows });
});

// ---- API: 查看全部 ----
app.get("/api/leads/all", (req, res) => {
  const rows = db.prepare("SELECT * FROM leads ORDER BY id DESC").all();
  res.json({ ok: true, rows });
});

// ========== 后台：列表 + 筛选 + 标记完成 + 员工统计 ==========

// 统一把表单 post 后跳回来源页
function redirectBack(req, res) {
  const back = req.headers.referer || "/admin";
  res.redirect(back);
}

// 查询工具：拼 where
function buildWhere({ status, staff, q }) {
  const where = [];
  const params = {};

  if (status && status !== "all") {
    where.push("status = @status");
    params.status = status;
  }
  if (staff) {
    where.push("staff_name = @staff");
    params.staff = staff;
  }
  if (q) {
    where.push(`(
      customer_name LIKE @kw OR
      customer_phone LIKE @kw OR
      customer_wecom_id LIKE @kw OR
      note LIKE @kw
    )`);
    params.kw = `%${q}%`;
  }

  return {
    whereSQL: where.length ? `WHERE ${where.join(" AND ")}` : "",
    params
  };
}

// 列表页：/admin?status=pending|done|all&staff=xxx&q=xxx
app.get("/admin", (req, res) => {
  const status = (req.query.status || "pending").toString();
  const staff = (req.query.staff || "").toString().trim();
  const q = (req.query.q || "").toString().trim();

  const { whereSQL, params } = buildWhere({ status, staff, q });

  const rows = db.prepare(`
    SELECT * FROM leads
    ${whereSQL}
    ORDER BY datetime(next_follow_at) ASC, id DESC
    LIMIT 300
  `).all(params);

  // 员工下拉
  const staffs = db.prepare(`
    SELECT staff_name, staff_wecom_userid, COUNT(*) as cnt
    FROM leads GROUP BY staff_name, staff_wecom_userid
    ORDER BY cnt DESC
  `).all();

  // 过期未跟进
  const overdue = db.prepare(`
    SELECT staff_name, staff_wecom_userid, COUNT(*) as cnt
    FROM leads
    WHERE status='pending' AND datetime(next_follow_at) <= datetime('now','+8 hours')
    GROUP BY staff_name, staff_wecom_userid
    ORDER BY cnt DESC
  `).all();

  const staffOptions =
    `<option value="">全部员工</option>` +
    staffs.map(s => `<option value="${escapeHtml(s.staff_name)}" ${s.staff_name===staff?"selected":""}>
      ${escapeHtml(s.staff_name)} (${escapeHtml(s.staff_wecom_userid)}) - ${s.cnt}
    </option>`).join("");

  const htmlRows = rows.map(r => `
    <tr>
      <td>${r.id}</td>
      <td>${escapeHtml(r.staff_name)}<div style="opacity:.6;font-size:12px">${escapeHtml(r.staff_wecom_userid)}</div></td>
      <td>${escapeHtml(r.customer_name)}</td>
      <td>${escapeHtml(r.customer_phone || "")}</td>
      <td>${escapeHtml(r.customer_wecom_id || "")}</td>
      <td style="max-width:260px;white-space:pre-wrap">${escapeHtml(r.note || "")}</td>
      <td>${escapeHtml(r.next_follow_at)}</td>
      <td>${escapeHtml(r.status)}</td>
      <td>
        ${r.status === "pending" ? `
          <form method="post" action="/api/leads/${r.id}/done" style="display:inline">
            <button type="submit">标记完成</button>
          </form>
        ` : "已完成"}
      </td>
    </tr>
  `).join("");

  const overdueBox = overdue.length
    ? overdue.map(o => `• ${escapeHtml(o.staff_name)} (${escapeHtml(o.staff_wecom_userid)})：<b>${o.cnt}</b> 条逾期未跟进`).join("<br/>")
    : "当前没有逾期未跟进线索 ✅";

  res.type("html").send(`
<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>线索后台</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",Arial; padding:16px;}
    .bar{display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-bottom:12px;}
    input,select{padding:8px; font-size:14px;}
    button{padding:8px 12px;}
    table{border-collapse:collapse; width:100%;}
    th,td{border:1px solid #e5e5e5; padding:8px; font-size:13px; vertical-align:top;}
    th{background:#fafafa; text-align:left;}
    .box{border:1px solid #e5e5e5; padding:12px; border-radius:10px; margin:12px 0; background:#fff;}
    .muted{opacity:.7}
  </style>
</head>
<body>
  <h2>线索后台</h2>

  <div class="box">
    <b>员工跟进检查（逾期未跟进）</b>
    <div class="muted" style="margin-top:6px">${overdueBox}</div>
  </div>

  <form class="bar" method="get" action="/admin">
    <label>状态：
      <select name="status">
        <option value="pending" ${status==="pending"?"selected":""}>待跟进</option>
        <option value="done" ${status==="done"?"selected":""}>已完成</option>
        <option value="all" ${status==="all"?"selected":""}>全部</option>
      </select>
    </label>

    <label>员工：
      <select name="staff">${staffOptions}</select>
    </label>

    <input name="q" value="${escapeHtml(q)}" placeholder="搜索：客户名/手机号/企微ID/备注" style="min-width:260px" />
    <button type="submit">筛选</button>
    <a href="/admin" style="margin-left:6px">重置</a>
  </form>

  <div class="muted">共 ${rows.length} 条（最多显示 300 条）</div>

  <table style="margin-top:10px">
    <tr>
      <th>ID</th><th>员工</th><th>客户</th><th>手机</th><th>客户企微</th><th>备注</th><th>下次跟进</th><th>状态</th><th>操作</th>
    </tr>
    ${htmlRows || `<tr><td colspan="9" class="muted">暂无数据</td></tr>`}
  </table>

</body>
</html>
  `);
});

// ---- API: 标记完成（只保留这一份，避免重复）----
app.post("/api/leads/:id/done", (req, res) => {
  const id = Number(req.params.id);
  markDone.run(id);
  redirectBack(req, res);
});

// ====== 日报：手动触发（浏览器访问即可） ======
async function sendDailyReport() {
  const todayNew = db.prepare(`
    SELECT COUNT(*) c
    FROM leads
    WHERE date(created_at) = date('now','+8 hours')
  `).get().c;

  const due = db.prepare(`
    SELECT COUNT(*) c
    FROM leads
    WHERE status='pending'
      AND datetime(next_follow_at) <= datetime('now','+8 hours')
  `).get().c;

  const total = db.prepare(`SELECT COUNT(*) c FROM leads`).get().c;

  const content = `📊 今日线索汇总
- 今日新增：${todayNew}
- 到期未跟进：${due}
- 总线索：${total}
请各员工及时跟进✅`;

  const r = await fetch(WEWORK_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msgtype: "text", text: { content } })
  });

  return await r.json();
}

app.get("/report/daily", async (req, res) => {
  try {
    const data = await sendDailyReport();
    res.json({ ok: true, wework: data });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ====== 到期扫描：每分钟扫一次（你原来的逻辑保留） ======
cron.schedule("* * * * *", () => {
  const rows = dueLeads.all(50);
  if (rows.length === 0) return;

  for (const lead of rows) {
    console.log(
      `[提醒] 员工=${lead.staff_name}(${lead.staff_wecom_userid}) ` +
      `客户=${lead.customer_name} 时间=${lead.next_follow_at} 备注=${lead.note || ""}`
    );
  }
});

// ====== 每天 09:00 自动发日报（北京时间） ======
cron.schedule("0 9 * * *", async () => {
  try {
    const data = await sendDailyReport();
    console.log("[日报] 已发送：", data);
  } catch (e) {
    console.error("[日报] 发送失败：", e);
  }
}, { timezone: "Asia/Shanghai" });

function toISO8(str) {
  const s = String(str).trim().replace(" ", "T");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    throw new Error("next_follow_at 格式需为 YYYY-MM-DD HH:mm");
  }
  return s.length === 16 ? `${s}:00+08:00` : `${s}+08:00`;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// 企微：跳转到授权
app.get("/auth/wecom", (req, res) => {
  const redirect = encodeURIComponent(`${BASE_URL}/auth/wecom/callback`);
  const state = encodeURIComponent(req.query.next || "/");
  const url =
    `https://open.weixin.qq.com/connect/oauth2/authorize` +
    `?appid=${CORP_ID}` +
    `&redirect_uri=${redirect}` +
    `&response_type=code` +
    `&scope=snsapi_base` +
    `&state=${state}` +
    `#wechat_redirect`;
  res.redirect(url);
});

// 企微：回调（用 code 换 userid）
app.get("/auth/wecom/callback", async (req, res) => {
  try {
    const code = String(req.query.code || "");
    const next = decodeURIComponent(String(req.query.state || "/"));
    if (!code) return res.status(400).send("missing code");

    // 1) 取 access_token
    const tokenResp = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${CORP_ID}&corpsecret=${APP_SECRET}`
    );
    const tokenData = await tokenResp.json();
    if (tokenData.errcode !== 0) return res.status(500).json(tokenData);

    const accessToken = tokenData.access_token;

    // 2) 用 code 换 userid
    const uiResp = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/user/getuserinfo?access_token=${accessToken}&code=${code}`
    );
    const uiData = await uiResp.json();
    if (uiData.errcode !== 0) return res.status(500).json(uiData);

    // 保存登录态
    req.session.wecom_userid = uiData.UserId || uiData.OpenId || "";
    res.redirect(next || "/");
  } catch (e) {
    res.status(500).send(String(e));
  }
});

// 守门：未登录就跳去企微授权
function requireWecom(req, res, next) {
  if (req.session?.wecom_userid) return next();
  const nextUrl = encodeURIComponent(req.originalUrl || "/");
  return res.redirect(`/auth/wecom?next=${nextUrl}`);
}

app.listen(3000, () => console.log("http://localhost:3000"));
