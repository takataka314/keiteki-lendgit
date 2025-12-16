//---------------------------------------------------------
// 必要ライブラリ（全部 ES Modules）
//---------------------------------------------------------
import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import path from "path";
import multer from "multer";
import csv from "csv-parser";
import fs from "fs";
import iconv from "iconv-lite";
import { Readable } from "stream";
import { fileURLToPath } from "url";

import { pool, initDb, hashPin } from "./models/db.js";
const PORT = process.env.PORT || 8080;
// ---------------------------------------------------------
// ES Modules 用 __dirname
// ---------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------
// 基本設定
// ---------------------------------------------------------
const app = express();
const upload = multer({ dest: "uploads/" });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

//---------------------------------------------------------
// セッション（PostgreSQL）
//---------------------------------------------------------
const PgSession = connectPgSimple(session);
app.use(
  session({
    store: new PgSession({
      pool,
      tableName: "session",
    }),
    secret: process.env.SESSION_SECRET || "change-me",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }, // 30日
  })
);

//---------------------------------------------------------
// 静的ファイル
//---------------------------------------------------------
app.use(express.static(path.join(__dirname, "public")));

// サーバー起動前に DB 準備

async function initDefaultStaff() {
  const name = "marusitsu";
  const email = "keiteki326sikkou@gmail.com";
  const pin = "0000"; // 初期PIN（後で変更可）
  const hashed = hashPin(pin);

  // すでに存在するか確認
  const result = await pool.query(
    "SELECT id FROM users WHERE name = $1",
    [name]
  );

  if (result.rowCount === 0) {
    await pool.query(
      `
      INSERT INTO users (name, email, pin, is_staff)
      VALUES ($1, $2, $3, true)
      `,
      [name, email, hashed]
    );

    console.log("✅ 初期スタッフを作成しました:", name);
  } else {
    console.log("ℹ 初期スタッフは既に存在します:", name);
  }
}

async function bootstrap() {
  await initDb();
  await initDefaultStaff();

  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
}

bootstrap().catch(err => {
  console.error("❌ Startup failed:", err);
  process.exit(1);
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
//---------------------------------------------------------
// ミドルウェア
//---------------------------------------------------------
function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "ログインが必要です" });
  }
  next();
}

function requireStaff(req, res, next) {
  if (!req.session.isStaff) {
    return res.status(403).json({ error: "スタッフ専用です" });
  }
  next();
}

//---------------------------------------------------------
// API: 自分の情報
//---------------------------------------------------------
app.get("/api/me", requireLogin, async (req, res) => {
  const result = await pool.query(
    `SELECT id, name, is_staff FROM users WHERE id = $1`,
    [req.session.userId]
  );
  const user = result.rows[0];

  res.json({
    id: user.id,
    name: user.name,
    is_staff: user.is_staff,
  });
});

//---------------------------------------------------------
// ログアウト
//---------------------------------------------------------
app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

//---------------------------------------------------------
// API: ログイン名一覧（プルダウン用）
//---------------------------------------------------------
app.get("/api/login-names", async (req, res) => {
  const result = await pool.query(
    `SELECT id, name, is_staff FROM users ORDER BY id`
  );

  res.json({
    names: result.rows.map((u) => ({
      id: u.id,
      name: u.name,
      type: u.is_staff ? "staff" : "user",
    })),
  });
});

//---------------------------------------------------------
// API: ログイン処理
//  ※ name に「ユーザーID」が入ってくる仕様のまま保持
//---------------------------------------------------------
app.post("/api/login", async (req, res) => {
  const { name, pin } = req.body; // name = users.id

  const result = await pool.query(
    `SELECT * FROM users WHERE id = $1`,
    [name]
  );
  const user = result.rows[0];

  if (!user || user.pin !== hashPin(pin)) {
    return res.status(401).json({ error: "ユーザー名かPINが違います" });
  }

  req.session.userId = user.id;
  req.session.isStaff = user.is_staff;

  res.json({ ok: true, role: user.is_staff ? "staff" : "user" });
});

//---------------------------------------------------------
// API: 新規登録（一般ユーザー）
//---------------------------------------------------------
// app.post("/api/register", async (req, res) => {
//   const { name, email, pin } = req.body;

//   try {
//     const hashed = hashPin(pin);
//     await pool.query(
//       `
//       INSERT INTO users (name, email, pin, is_staff)
//       VALUES ($1, $2, $3, 0)
//     `,
//       [name, email, hashed]
//     );

//     res.json({ ok: true });
//   } catch (err) {
//     console.error("register error:", err);
//     res.status(500).json({ ok: false, error: "登録に失敗しました" });
//   }
// });
app.post("/api/register", async (req, res) => {
  const { name, email, pin } = req.body;

  if (!name || !pin) {
    return res.status(400).json({ ok: false, error: "必須項目が不足しています" });
  }

  if (!/^\d{4}$/.test(pin)) {
    return res.status(400).json({
      ok: false,
      error: "PINは4桁の数字で入力してください",
    });
  }

  try {
    const hashed = hashPin(pin);

    await pool.query(
      `INSERT INTO users (name, email, pin, is_staff)
       VALUES ($1, $2, $3, false)`,
      [name, email, hashed]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("register error:", err);
    res.status(500).json({ ok: false, error: "登録に失敗しました" });
  }
});

//---------------------------------------------------------
// API: スタッフ作成用（手動追加用）
//---------------------------------------------------------
app.post("/api/setup_staff", async (req, res) => {
  const { name, email, pin } = req.body;

  try {
    const hashed = hashPin(pin);
    await pool.query(
      `
      INSERT INTO users (name, email, pin, is_staff)
      VALUES ($1, $2, $3, 1)
    `,
      [name, email, hashed]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("setup_staff error:", err);
    res.status(500).json({ ok: false, error: "スタッフ登録に失敗しました" });
  }
});

//---------------------------------------------------------
// API: 物品一覧（available 付き）
//---------------------------------------------------------
app.get("/api/items", requireLogin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        i.*,
        (
          i.total_qty
          - COALESCE(
              (SELECT SUM(qty)
               FROM loans
               WHERE item_id = i.id AND returned_at IS NULL),
              0
            )
        ) AS available
      FROM items i
      ORDER BY i.id
    `);

    res.json({ items: result.rows });
  } catch (err) {
    console.error("items error:", err);
    res.status(500).json({ error: "物品一覧取得に失敗しました" });
  }
});

//---------------------------------------------------------
// API: 物品一括追加
//---------------------------------------------------------
app.post("/api/items/bulk", requireLogin, requireStaff, async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) {
    return res.json({ ok: false, error: "無効なデータ" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const row of items) {
      await client.query(
        `INSERT INTO items (category, name, total_qty)
         VALUES ($1, $2, $3)`,
        [row.category, row.name, Number(row.qty)]
      );
    }
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("items bulk error:", err);
    res.json({ ok: false, error: "DB登録に失敗しました" });
  } finally {
    client.release();
  }
});

//---------------------------------------------------------
// API: 複数物品更新（在庫＋備考）
//---------------------------------------------------------
app.post("/api/items/update-bulk", requireLogin, requireStaff, async (req, res) => {
  const { updates } = req.body;
  if (!Array.isArray(updates)) {
    return res.json({ ok: false, error: "無効なデータ" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const r of updates) {
      await client.query(
        `UPDATE items SET total_qty = $1, note = $2 WHERE id = $3`,
        [r.total_qty, r.note, r.id]
      );
    }
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("update-bulk error:", err);
    res.json({ ok: false, error: err.message });
  } finally {
    client.release();
  }
});

//---------------------------------------------------------
// 在庫だけ増減
//---------------------------------------------------------
app.post("/api/items/update_qty", requireLogin, requireStaff, async (req, res) => {
  const { id, delta } = req.body;

  try {
    const itemResult = await pool.query(
      `SELECT total_qty FROM items WHERE id = $1`,
      [id]
    );
    if (itemResult.rowCount === 0) {
      return res.json({ ok: false, error: "物品が存在しません" });
    }

    const currentQty = itemResult.rows[0].total_qty;
    const newQty = Math.max(0, currentQty + delta);

    await pool.query(
      `UPDATE items SET total_qty = $1 WHERE id = $2`,
      [newQty, id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("update_qty error:", err);
    res.json({ ok: false, error: err.message });
  }
});

//---------------------------------------------------------
// 備考のみ更新
//---------------------------------------------------------
app.post("/api/items/update_note", requireLogin, requireStaff, async (req, res) => {
  const { id, note } = req.body;

  try {
    const itemResult = await pool.query(
      `SELECT id FROM items WHERE id = $1`,
      [id]
    );
    if (itemResult.rowCount === 0) {
      return res.json({ ok: false, error: "物品が存在しません" });
    }

    await pool.query(
      `UPDATE items SET note = $1 WHERE id = $2`,
      [note, id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("update_note error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

//---------------------------------------------------------
// API: 貸出
//---------------------------------------------------------
app.post("/api/loans", requireLogin, async (req, res) => {
  const { item_id, lender_id, qty, room } = req.body;

  try {
    // 在庫確認
    const availableResult = await pool.query(
      `
      SELECT
        i.total_qty
        - COALESCE(
            (SELECT SUM(qty) FROM loans WHERE item_id = $1 AND returned_at IS NULL),
            0
          ) AS available
      FROM items i
      WHERE i.id = $1
      `,
      [item_id]
    );

    if (availableResult.rowCount === 0) {
      return res.json({ error: "物品が存在しません" });
    }

    const available = availableResult.rows[0].available;
    if (available < qty) {
      return res.json({ error: "在庫不足です" });
    }

    const staffId = req.session.userId;

    await pool.query(
      `
      INSERT INTO loans (item_id, lender_id, qty, room, staff_id)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [item_id, lender_id, qty, room, staffId]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("loans create error:", err);
    res.status(500).json({ error: err.message });
  }
});

//---------------------------------------------------------
// API: 未返却一覧
//---------------------------------------------------------
app.get("/api/loans/unreturned", requireLogin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        loans.id,
        loans.room,
        loans.qty,
        loans.borrowed_at,
        items.name   AS "itemName",
        lenders.name AS "lenderName",
        users.name   AS "userName"
      FROM loans
      JOIN items   ON loans.item_id   = items.id
      JOIN lenders ON loans.lender_id = lenders.id
      LEFT JOIN users ON loans.staff_id = users.id
      WHERE loans.returned_at IS NULL
      ORDER BY loans.borrowed_at ASC
    `);

    res.json({ loans: result.rows });
  } catch (err) {
    console.error("unreturned error:", err);
    res.status(500).json({ error: err.message });
  }
});

//---------------------------------------------------------
// API: 返却（1件）
//---------------------------------------------------------
app.post("/api/loans/return", requireLogin, async (req, res) => {
  const { id } = req.body;

  try {
    await pool.query(
      `
      UPDATE loans
      SET returned_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("return error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

//---------------------------------------------------------
// API: 返却（複数行一括）
//---------------------------------------------------------
app.post("/api/loans/return/bulk", requireLogin, async (req, res) => {
  const ids = req.body.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.json({ error: "IDがありません" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const id of ids) {
      await client.query(
        `
        UPDATE loans
        SET returned_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND returned_at IS NULL
        `,
        [id]
      );
    }

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("bulk return error:", err);
    res.json({ ok: false, error: err.message });
  } finally {
    client.release();
  }
});

//---------------------------------------------------------
// API: 貸出人一覧
//---------------------------------------------------------
app.get("/api/lenders", requireLogin, async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM lenders ORDER BY id DESC"
  );
  res.json({ lenders: result.rows });
});

//---------------------------------------------------------
// API: 履歴一覧 + 検索 + 未返却フィルタ
//---------------------------------------------------------
app.get("/api/history", requireLogin, requireStaff, async (req, res) => {
  const staffId = req.session.userId;
  const userResult = await pool.query(
    "SELECT is_staff FROM users WHERE id = $1",
    [staffId]
  );
  const user = userResult.rows[0];
  if (!user || ! user.is_staff) {
    return res.status(403).json({ error: "アクセス権がありません" });
  }

  const q = req.query.q ? `%${req.query.q}%` : `%`;
  const onlyNot = req.query.onlyNot === "1";

  const sql = `
    SELECT 
      loans.id,
      items.name   AS item_name,
      items.category,
      users.name AS lender_name,
      loans.qty,
      loans.room,
      loans.borrowed_at,
      loans.returned_at,
      lenders.name AS staff_name
    FROM loans
      JOIN items   ON loans.item_id   = items.id
      JOIN lenders ON loans.lender_id = lenders.id
      LEFT JOIN users ON loans.staff_id = users.id
    WHERE 
      (loans.room ILIKE $1 OR items.name ILIKE $1 OR lenders.name ILIKE $1)
      ${onlyNot ? "AND loans.returned_at IS NULL" : ""}
    ORDER BY loans.room ASC, loans.borrowed_at DESC
  `;

  const result = await pool.query(sql, [q]);
  res.json(result.rows);
});

//---------------------------------------------------------
// CSVアップロード → lenders 登録（Shift-JIS 対応）
//---------------------------------------------------------
app.post("/api/lenders/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "CSVファイルを選択してください" });
  }

  const fileBuffer = fs.readFileSync(req.file.path);
  const utf8Text = iconv.decode(fileBuffer, "Shift_JIS");
  const stream = Readable.from(utf8Text);

  const results = [];

  stream
    .pipe(csv())
    .on("data", (row) => {
      if (row.name && row.name.trim() !== "") {
        results.push(row.name.trim());
      }
    })
    .on("end", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const stmt = "INSERT INTO lenders (name) VALUES ($1)";
        for (const name of results) {
          await client.query(stmt, [name]);
        }

        await client.query("COMMIT");
        fs.unlinkSync(req.file.path);
        res.json({ ok: true, count: results.length });
      } catch (err) {
        await client.query("ROLLBACK");
        console.error("CSV insert error:", err);
        res.json({ ok: false, error: err.message });
      } finally {
        client.release();
      }
    })
    .on("error", (err) => {
      console.error("CSV parse error:", err);
      res.json({ ok: false, error: "CSV読み込みエラー: " + err.message });
    });
});

//---------------------------------------------------------
// サーバー起動
//---------------------------------------------------------

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});