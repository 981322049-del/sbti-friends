const express = require('express');
const cors = require('cors');
const path = require('path');
const { sql } = require('@vercel/postgres');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

// =============================================
// 数据库初始化（Vercel Serverless 每次冷启动会调用）
// =============================================
async function initDb() {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS owners (
        uid         TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        type        TEXT,
        pattern     TEXT,
        answers     JSONB,
        paid_count  INTEGER DEFAULT 0,
        created_at  BIGINT
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS friends (
        id          SERIAL PRIMARY KEY,
        owner_uid   TEXT NOT NULL,
        name        TEXT,
        anon        BOOLEAN DEFAULT FALSE,
        answers     JSONB,
        paid        BOOLEAN DEFAULT FALSE,
        pay_pending BOOLEAN DEFAULT FALSE,
        order_id    TEXT,
        friend_type TEXT,
        paid_at     BIGINT,
        ts          BIGINT
      )
    `;
    console.log('✅ Database tables initialized');
  } catch (e) {
    console.error('❌ DB init error:', e.message);
  }
}

// =============================================
// API 路由
// =============================================

// 1. 创建发起者（答题）
app.post('/api/owner', async (req, res) => {
  await initDb();
  const { name, type, pattern, answers } = req.body;
  if (!name || !answers || answers.length !== 30) {
    return res.status(400).json({ error: '参数不完整' });
  }
  const uid = Math.random().toString(36).slice(2, 10);
  try {
    await sql`
      INSERT INTO owners (uid, name, type, pattern, answers, created_at)
      VALUES (${uid}, ${name}, ${type}, ${pattern}, ${JSON.stringify(answers)}, ${Date.now()})
    `;
    console.log(`Owner created: ${name} (${uid})`);
    res.json({ uid, name, type, pattern, friendsCount: 0 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '创建失败' });
  }
});

// 2. 获取发起者数据
app.get('/api/owner/:uid', async (req, res) => {
  await initDb();
  const { uid } = req.params;
  try {
    const { rows } = await sql`SELECT * FROM owners WHERE uid = ${uid}`;
    if (!rows[0]) return res.status(404).json({ error: '问卷不存在' });
    const o = rows[0];
    const { rows: friends } = await sql`SELECT COUNT(*) as cnt FROM friends WHERE owner_uid = ${uid}`;
    res.json({
      uid: o.uid, name: o.name, type: o.type, pattern: o.pattern,
      answers: o.answers, friendsCount: parseInt(friends[0].cnt),
      paidCount: o.paid_count, createdAt: o.created_at,
    });
  } catch (e) {
    res.status(500).json({ error: '查询失败' });
  }
});

// 3. 提交好友答案
app.post('/api/friend', async (req, res) => {
  await initDb();
  const { ownerUid, name, anon, answers } = req.body;
  if (!ownerUid || !answers || answers.length !== 30) {
    return res.status(400).json({ error: '参数不完整' });
  }
  try {
    // 简单去重（同 name + 非匿名）
    if (!anon) {
      const { rows } = await sql`SELECT id FROM friends WHERE owner_uid = ${ownerUid} AND name = ${name} AND anon = FALSE`;
      if (rows[0]) return res.status(409).json({ error: '该昵称已作答' });
    }
    await sql`
      INSERT INTO friends (owner_uid, name, anon, answers, ts)
      VALUES (${ownerUid}, ${name || '神秘朋友'}, ${!!anon}, ${JSON.stringify(answers)}, ${Date.now()})
    `;
    const { rows } = await sql`SELECT COUNT(*) as cnt FROM friends WHERE owner_uid = ${ownerUid}`;
    console.log(`Friend submitted: ${name} -> ${ownerUid}, total: ${rows[0].cnt}`);
    res.json({ success: true, friendsCount: parseInt(rows[0].cnt) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '提交失败' });
  }
});

// 4. 获取好友列表详情
app.get('/api/owner/:uid/friends', async (req, res) => {
  await initDb();
  const { uid } = req.params;
  try {
    const { rows } = await sql`SELECT * FROM friends WHERE owner_uid = ${uid} ORDER BY ts ASC`;
    // 重塑字段名
    const friends = rows.map(f => ({
      name: f.name, anon: f.anon, answers: f.answers,
      paid: f.paid, payPending: f.pay_pending,
      orderId: f.order_id, friendType: f.friend_type, paidAt: f.paid_at, ts: f.ts,
    }));
    res.json({ friends });
  } catch (e) {
    res.status(500).json({ error: '查询失败' });
  }
});

// 5. 获取所有发起者列表
app.get('/api/owners', async (req, res) => {
  await initDb();
  try {
    const { rows } = await sql`SELECT uid, name, type, paid_count, created_at FROM owners ORDER BY created_at DESC`;
    const list = rows.map(o => ({
      uid: o.uid, name: o.name, type: o.type,
      friendsCount: 0, paidCount: o.paid_count, createdAt: o.created_at,
    }));
    // 补上 friendsCount
    for (const item of list) {
      const { rows: r } = await sql`SELECT COUNT(*) as cnt FROM friends WHERE owner_uid = ${item.uid}`;
      item.friendsCount = parseInt(r[0].cnt);
    }
    res.json({ total: list.length, list });
  } catch (e) {
    res.status(500).json({ error: '查询失败' });
  }
});

// 6. 记录好友支付申请 / 确认收款
app.post('/api/pay', async (req, res) => {
  await initDb();
  const { ownerUid, friendName, friendType, orderId, status } = req.body;
  if (!ownerUid) return res.status(400).json({ error: '缺少参数' });

  try {
    const { rows: existing } = await sql`
      SELECT * FROM friends WHERE owner_uid = ${ownerUid} AND name = ${friendName}
    `;
    if (!existing[0]) return res.status(404).json({ error: '好友记录不存在' });
    if (existing[0].paid) return res.status(409).json({ error: '已支付过' });

    if (status === 'pending') {
      // 朋友提交待确认
      await sql`
        UPDATE friends SET pay_pending = TRUE, order_id = ${orderId || ''}, friend_type = ${friendType || ''}
        WHERE owner_uid = ${ownerUid} AND name = ${friendName}
      `;
      console.log(`⏳ Pay pending: ${friendName} -> ${ownerUid} (order: ${orderId})`);
      return res.json({ success: true, pending: true });
    }

    // 直接确认（兜底）
    await sql`UPDATE friends SET paid = TRUE, paid_at = ${Date.now()}, pay_pending = FALSE WHERE owner_uid = ${ownerUid} AND name = ${friendName}`;
    const { rows } = await sql`SELECT COUNT(*) as cnt FROM friends WHERE owner_uid = ${ownerUid} AND paid = TRUE`;
    await sql`UPDATE owners SET paid_count = ${parseInt(rows[0].cnt)} WHERE uid = ${ownerUid}`;
    console.log(`✅ Pay confirmed: ${friendName} -> ${ownerUid}`);
    res.json({ success: true, paidCount: parseInt(rows[0].cnt) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '支付记录失败' });
  }
});

// 7. 发起者确认收款
app.post('/api/confirm-pay', async (req, res) => {
  await initDb();
  const { ownerUid, friendName } = req.body;
  if (!ownerUid || !friendName) return res.status(400).json({ error: '缺少参数' });
  try {
    await sql`
      UPDATE friends SET paid = TRUE, paid_at = ${Date.now()}, pay_pending = FALSE
      WHERE owner_uid = ${ownerUid} AND name = ${friendName}
    `;
    const { rows } = await sql`SELECT COUNT(*) as cnt FROM friends WHERE owner_uid = ${ownerUid} AND paid = TRUE`;
    await sql`UPDATE owners SET paid_count = ${parseInt(rows[0].cnt)} WHERE uid = ${ownerUid}`;
    console.log(`✅ Confirmed pay: ${friendName} for ${ownerUid}`);
    res.json({ success: true, paidCount: parseInt(rows[0].cnt) });
  } catch (e) {
    res.status(500).json({ error: '确认失败' });
  }
});

// 8. 查询好友支付状态（轮询）
app.get('/api/pay-status', async (req, res) => {
  await initDb();
  const { ownerUid, friendName } = req.query;
  if (!ownerUid || !friendName) return res.status(400).json({ error: '缺少参数' });
  try {
    const { rows } = await sql`SELECT paid, pay_pending FROM friends WHERE owner_uid = ${ownerUid} AND name = ${friendName}`;
    if (!rows[0]) return res.status(404).json({ paid: false, pending: false });
    res.json({ paid: rows[0].paid, pending: rows[0].pay_pending });
  } catch (e) {
    res.status(500).json({ paid: false, pending: false });
  }
});

// 9. 统计概览
app.get('/api/stats', async (req, res) => {
  await initDb();
  try {
    const { rows: owners } = await sql`SELECT COUNT(*) as cnt FROM owners`;
    const { rows: friends } = await sql`SELECT COUNT(*) as cnt FROM friends`;
    res.json({ totalOwners: parseInt(owners[0].cnt), totalFriends: parseInt(friends[0].cnt) });
  } catch (e) {
    res.status(500).json({ error: '查询失败' });
  }
});

// =============================================
// 页面路由
// =============================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/share/:uid', (req, res) => {
  res.redirect(`/#friend/${req.params.uid}`);
});

// 启动（Vercel Serverless 环境也支持 listen）
initDb();
app.listen(PORT, () => {
  console.log(`\n🎉 SBTI 朋友互猜 已启动！`);
  console.log(`   本地访问: http://localhost:${PORT}\n`);
});

module.exports = app;
