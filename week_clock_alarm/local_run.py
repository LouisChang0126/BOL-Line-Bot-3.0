"""
python local_run.py
ngrok http 6000
"""

from flask import Flask, request
import os

# 匯入原本 week_clock_alarm.py 中的 cloud_Scheduler 函式
from week_clock_alarm import cloud_Scheduler

app = Flask(__name__)

@app.route("/", methods=['POST'])
def callback():
    # 將 Flask 的 request 物件直接傳給你的 GCF 函式
    return cloud_Scheduler(request)

if __name__ == "__main__":
    # 啟動本地伺服器，預設 Port 5000
    # debug=True 可以讓你在修改程式碼後自動重啟
    app.run(port=6000, debug=True)