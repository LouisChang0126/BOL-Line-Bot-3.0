from flask import Flask, request
import os

# 匯入原本 main.py 中的 lineWebhook 函式
# 注意：這行執行時，main.py 最上方的 Firebase 初始化也會被執行
from main import lineWebhook

app = Flask(__name__)

@app.route("/", methods=['POST'])
def callback():
    # 將 Flask 的 request 物件直接傳給你的 GCF 函式
    return lineWebhook(request)

if __name__ == "__main__":
    # 啟動本地伺服器，預設 Port 5000
    # debug=True 可以讓你在修改程式碼後自動重啟
    app.run(port=5000, debug=True)