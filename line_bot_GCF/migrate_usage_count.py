"""
一次性遷移腳本：把所有 user 的 usage_count 月份 key 從 YYYY.MM 改成 YYYY_MM。

背景：
    log_usage() 已改用 firestore.Increment + dotted field path，
    新格式月份 key 改用 "YYYY_MM"（避免 . 被當成 nested separator）。
    DB 內舊資料仍是 "YYYY.MM"，這支 script 把舊 key 重新命名成新格式，
    若同月份兩種 key 同時存在（部署過渡期），會合計後寫回新格式。

安全性：
    用 transaction 包讀+寫，避免遷移途中 log_usage 的 Increment 被覆蓋
    （transaction 偵測到版本衝突會自動 retry）。

使用方式：
    cd line_bot_GCF
    python migrate_usage_count.py --dry-run     # 先預覽會改什麼，不寫入
    python migrate_usage_count.py               # 真正執行
"""
import argparse
import re

import firebase_admin
from firebase_admin import credentials, firestore

cred = credentials.Certificate('serviceAccount.json')
firebase_admin.initialize_app(cred)
db = firestore.client()

# 只處理嚴格符合 YYYY.MM 的 key，不去動其他奇怪格式
OLD_FORMAT = re.compile(r'^\d{4}\.\d{2}$')


def merge_usage(usage_count):
    """把 usage_count 的月份 key normalize 成 YYYY_MM 並合併同月計數。
    回傳 (new_usage_dict, changed: bool)。"""
    new_usage = {}
    changed = False
    for month_key, counts in (usage_count or {}).items():
        if OLD_FORMAT.match(month_key):
            new_key = month_key.replace('.', '_')
            changed = True
        else:
            new_key = month_key
        bucket = new_usage.setdefault(new_key, {})
        for action, n in (counts or {}).items():
            try:
                bucket[action] = bucket.get(action, 0) + int(n)
            except (TypeError, ValueError):
                # 異常資料保留原值，不要靜默吞掉
                bucket[action] = n
    return new_usage, changed


def migrate_one(user_ref, dry_run):
    """對單一 user 執行遷移。回傳 ('skip'|'updated'|'dry', old_keys, new_keys)。"""
    @firestore.transactional
    def _txn(txn):
        snap = user_ref.get(transaction=txn)
        if not snap.exists:
            return ('skip', [], [])
        data = snap.to_dict() or {}
        usage_count = data.get('usage_count') or {}
        new_usage, changed = merge_usage(usage_count)
        old_keys = sorted(usage_count.keys())
        new_keys = sorted(new_usage.keys())
        if not changed:
            return ('skip', old_keys, new_keys)
        if dry_run:
            return ('dry', old_keys, new_keys)
        txn.update(user_ref, {'usage_count': new_usage})
        return ('updated', old_keys, new_keys)

    return _txn(db.transaction())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true', help='只印出變動，不寫入')
    args = parser.parse_args()

    docs = list(db.collection('users').stream())
    print(f"掃描 {len(docs)} 個 users{'（dry-run，不會寫入）' if args.dry_run else ''}...\n")

    touched = 0
    skipped = 0
    for d in docs:
        try:
            status, old_keys, new_keys = migrate_one(d.reference, args.dry_run)
        except Exception as e:
            print(f"[ERROR] {d.id}: {e}")
            continue

        if status == 'skip':
            skipped += 1
            continue
        touched += 1
        print(f"[{status}] {d.id}")
        print(f"    舊 keys: {old_keys}")
        print(f"    新 keys: {new_keys}")

    print(f"\n完成。有變動的 user：{touched} / {len(docs)}（跳過 {skipped} 個）")
    if args.dry_run and touched > 0:
        print("這是 dry-run。確認 OK 後請拿掉 --dry-run 再跑一次以實際寫入。")


if __name__ == '__main__':
    main()
