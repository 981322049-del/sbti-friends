const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

// 中间件
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

// 数据存储（内存 + 文件持久化）
let db = { owners: {} };

function loadDb() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      db = JSON.parse(raw);
      console.log(`Loaded ${Object.keys(db.owners).length} owners from disk`);
    }
  } catch (e) {
    console.error('Failed to load data:', e.message);
  }
}

function saveDb() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('Failed to save data:', e.message);
  }
}

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

// =============================================
// API 路由
// =============================================

// 1. 创建发起者
app.post('/api/owner', (req, res) => {
  const { name, type, pattern, answers } = req.body;
  if (!name || !answers || answers.length !== 30) {
    return res.status(400).json({ error: '参数不完整' });
  }
  const uid = genId();
  db.owners[uid] = {
    uid, name, type, pattern, answers,
    friends: [], paidCount: 0, createdAt: Date.now(),
  };
  saveDb();
  console.log(`Owner created: ${name} (${uid}), total: ${Object.keys(db.owners).length}`);
  res.json({ uid, name, type, pattern, friendsCount: 0 });
});

// 2. 获取发起者数据
app.get('/api/owner/:uid', (req, res) => {
  const owner = db.owners[req.params.uid];
  if (!owner) return res.status(404).json({ error: '问卷不存在' });
  res.json({
    uid: owner.uid, name: owner.name, type: owner.type,
    pattern: owner.pattern, answers: owner.answers,
    friendsCount: owner.friends.length,
    paidCount: owner.paidCount || 0, createdAt: owner.createdAt,
  });
});

// 3. 提交好友答案
app.post('/api/friend', (req, res) => {
  const { ownerUid, name, anon, answers } = req.body;
  if (!ownerUid || !answers || answers.length !== 30) {
    return res.status(400).json({ error: '参数不完整' });
  }
  const owner = db.owners[ownerUid];
  if (!owner) return res.status(404).json({ error: '问卷不存在' });

  if (!anon) {
    const already = owner.friends.find(f => f.name === name && !f.anon);
    if (already) return res.status(409).json({ error: '该昵称已作答' });
  }

  owner.friends.push({
    name: name || '神秘朋友', anon: !!anon, answers,
    paid: false, payPending: false, orderId: '', friendType: '', paidAt: null, ts: Date.now(),
  });
  saveDb();
  console.log(`Friend submitted: ${name} -> ${owner.name}, total: ${owner.friends.length}`);
  res.json({ success: true, friendsCount: owner.friends.length });
});

// 4. 获取好友列表
app.get('/api/owner/:uid/friends', (req, res) => {
  const owner = db.owners[req.params.uid];
  if (!owner) return res.status(404).json({ error: '问卷不存在' });
  res.json({ friends: owner.friends });
});

// 5. 所有发起者列表
app.get('/api/owners', (req, res) => {
  const list = Object.values(db.owners)
    .map(o => ({
      uid: o.uid, name: o.name, type: o.type,
      friendsCount: o.friends.length, paidCount: o.paidCount || 0, createdAt: o.createdAt,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json({ total: list.length, list });
});

// 6. 记录支付申请 / 确认收款
app.post('/api/pay', (req, res) => {
  const { ownerUid, friendName, friendType, orderId, status } = req.body;
  if (!ownerUid) return res.status(400).json({ error: '缺少参数' });
  const owner = db.owners[ownerUid];
  if (!owner) return res.status(404).json({ error: '问卷不存在' });

  const friend = owner.friends.find(f => f.name === friendName);
  if (!friend) return res.status(404).json({ error: '好友记录不存在' });
  if (friend.paid) return res.status(409).json({ error: '已支付过' });

  if (status === 'pending') {
    friend.payPending = true;
    friend.orderId = orderId || '';
    friend.friendType = friendType || '';
    saveDb();
    console.log(`⏳ Pay pending: ${friendName} -> ${owner.name}`);
    return res.json({ success: true, pending: true });
  }

  friend.paid = true;
  friend.paidAt = Date.now();
  friend.payPending = false;
  owner.paidCount = (owner.paidCount || 0) + 1;
  saveDb();
  console.log(`✅ Pay confirmed: ${friendName} for ${owner.name}`);
  res.json({ success: true, paidCount: owner.paidCount });
});

// 7. 发起者确认收款
app.post('/api/confirm-pay', (req, res) => {
  const { ownerUid, friendName } = req.body;
  if (!ownerUid || !friendName) return res.status(400).json({ error: '缺少参数' });
  const owner = db.owners[ownerUid];
  if (!owner) return res.status(404).json({ error: '问卷不存在' });

  const friend = owner.friends.find(f => f.name === friendName);
  if (!friend) return res.status(404).json({ error: '好友记录不存在' });

  friend.paid = true;
  friend.paidAt = Date.now();
  friend.payPending = false;
  owner.paidCount = (owner.paidCount || 0) + 1;
  saveDb();
  console.log(`✅ Confirmed pay: ${friendName} for ${owner.name}`);
  res.json({ success: true, paidCount: owner.paidCount });
});

// 8. 查询支付状态（轮询）
app.get('/api/pay-status', (req, res) => {
  const { ownerUid, friendName } = req.query;
  if (!ownerUid || !friendName) return res.status(400).json({ error: '缺少参数' });
  const owner = db.owners[ownerUid];
  if (!owner) return res.status(404).json({ paid: false, pending: false });

  const friend = owner.friends.find(f => f.name === friendName);
  if (!friend) return res.status(404).json({ paid: false, pending: false });
  res.json({ paid: !!friend.paid, pending: !!friend.payPending });
});

// 9. 统计概览
app.get('/api/stats', (req, res) => {
  const owners = Object.values(db.owners);
  res.json({
    totalOwners: owners.length,
    totalFriends: owners.reduce((s, o) => s + o.friends.length, 0),
  });
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

// 启动
loadDb();
app.listen(PORT, () => {
  console.log(`🎉 SBTI 朋友互猜 已启动！`);
  console.log(`   访问地址: http://localhost:${PORT}`);
  console.log(`   数据文件: ${DATA_FILE}`);
  console.log(`   当前数据: ${Object.keys(db.owners).length} 位发起者\n`);
});
