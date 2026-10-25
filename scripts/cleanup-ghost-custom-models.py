#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一次性清理：删除已删除的自定义提供商残留的 customModels 孤儿行。

孤儿判定（保守，三条同时满足才删）：
  1. key 的 providerId 以兼容节点前缀开头（openai-compatible- / anthropic-compatible- / custom-embedding-）
  2. providerNodes 表中无该 id（节点已删）
  3. providerConnections 表中无该 provider（连接也没了）
内置免费提供商（如 oc）的自定义模型不受影响。删除前自动备份数据库，逐行打印。

用法: python3 cleanup-ghost-custom-models.py <data.sqlite 路径>
"""
import json
import os
import shutil
import sqlite3
import sys
import datetime

PREFIXES = ("openai-compatible-", "anthropic-compatible-", "custom-embedding-")


def main(db_path):
    if not os.path.exists(db_path):
        print(f"[ABORT] DB 不存在: {db_path}")
        return 2

    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = db_path + f".bak-ghost-{ts}"
    shutil.copy2(db_path, backup)
    print(f"[BACKUP] {backup} ({os.path.getsize(backup)} bytes)")

    con = sqlite3.connect(db_path)
    cur = con.cursor()
    node_ids = {r[0] for r in cur.execute("SELECT id FROM providerNodes")}
    conn_ids = {r[0] for r in cur.execute("SELECT DISTINCT provider FROM providerConnections")}
    rows = cur.execute("SELECT key, value FROM kv WHERE scope='customModels'").fetchall()

    ghosts = []
    for k, v in rows:
        pid = k.split("|", 1)[0]
        if pid.startswith(PREFIXES) and pid not in node_ids and pid not in conn_ids:
            ghosts.append((k, v))

    print(f"[SCAN] customModels 总数={len(rows)}  命中孤儿={len(ghosts)}")
    if not ghosts:
        print("[OK] 无残留，无需清理")
        con.close()
        return 0

    for k, v in ghosts:
        try:
            name = json.loads(v).get("name", "")
        except Exception:
            name = ""
        print(f"  [DELETE] {k}  (name={name})")

    cur.executemany(
        "DELETE FROM kv WHERE scope='customModels' AND key=?",
        [(k,) for k, _ in ghosts],
    )
    con.commit()
    print(f"[DONE] 已删除 {len(ghosts)} 行")
    con.close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
