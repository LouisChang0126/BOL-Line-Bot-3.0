from flask import Flask, request
from main import generate_agent_schedule

app = Flask(__name__)

# 攔截所有路徑和方法，將請求轉交給 Cloud Function 的入口點
@app.route("/", methods=["GET", "POST", "OPTIONS"])
@app.route("/<path:path>", methods=["GET", "POST", "OPTIONS"])
def index(path=""):
    # generate_agent_schedule 預期收到一個 Flask request 物件
    # 回傳值是一個 Flask response（符合 Cloud Function 標準）
    return generate_agent_schedule(request)

if __name__ == "__main__":
    print("="*50)
    print("🚀 本地測試伺服器已啟動！")
    print("👉 請在前端 firebase-config.js 將 AGENT_API_URL 修改為: http://localhost:8087/")
    print("⏳ 按 Ctrl+C 結束...")
    print("="*50)
    # 啟動在 8087 port，符合 GCF 本地測試的習慣
    app.run(port=8087, debug=True)
