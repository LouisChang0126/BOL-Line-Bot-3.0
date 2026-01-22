from chatBotConfig import channel_secret, channel_access_token
from linebot import LineBotApi
from linebot.models import (
    TextSendMessage
)
###firestore
import firebase_admin
from firebase_admin import credentials
from firebase_admin import firestore
# 引用私密金鑰  
cred = credentials.Certificate('serviceAccount.json')
# 初始化firebase，注意不能重複初始化
firebase_admin.initialize_app(cred)
# 初始化firestore
db = firestore.client()
###endFirestore
import json
from datetime import datetime, timedelta, date

    
def reminder_all_serves():
    """
    提醒所有崇拜這週有服事的人
    
    流程：
    1. 從 _config/serve-list 取得所有崇拜清單
    2. 計算這週日的日期
    3. 遍歷每個崇拜，取得該週日的服事資料
    4. 整理成 {人員: [崇拜名-服事項目, ...]} 的格式
    5. 檢查每個有服事的用戶今天是否要被提醒
    6. 發送提醒訊息
    """
    line_bot_api = LineBotApi(channel_access_token)
    
    # 計算這週日的日期
    today = datetime.now()
    days_until_sunday = (6 - today.weekday()) % 7  # weekday(): Monday=0, Sunday=6
    if days_until_sunday == 0:
        days_until_sunday = 7  # 如果今天是週日，取下週日
    this_sunday = (today + timedelta(days=days_until_sunday)).strftime("%Y.%m.%d")
    
    # 1. 從 _config/serve-list 取得所有崇拜清單
    serve_list_doc = db.collection("_config").document("serve-list").get()
    if not serve_list_doc.exists:
        print("找不到 _config/serve-list")
        return
    
    serves = serve_list_doc.to_dict().get('serves', [])
    
    # 2. 整理每個人這週的服事 {人員: [(崇拜名, 服事項目), ...]}
    person_serves = {}
    
    for serve_info in serves:
        collection_id = serve_info.get('id')
        serve_name = serve_info.get('name', collection_id)
        emoji = serve_info.get('emoji', '')
        display_name = f"{emoji} {serve_name}".strip()

        # 取得該崇拜這週日的服事資料
        schedule_doc = db.collection(collection_id).document(this_sunday).get()
        if not schedule_doc.exists:
            continue
        
        schedule_data = schedule_doc.to_dict()
        
        # 遍歷所有服事項目
        for serve_type, persons in schedule_data.items():
            # 跳過非服事項目的欄位
            if not isinstance(persons, list):
                continue
            
            for person in persons:
                if person not in person_serves:
                    person_serves[person] = []
                person_serves[person].append(f"{display_name}-{serve_type}")
    
    # 3. 檢查每個有服事的用戶今天是否要被提醒，並發送訊息
    today_weekday = today.weekday()  # Monday=0, Sunday=6
    
    for person_name, serve_list in person_serves.items():
        print(f"用戶 {person_name} 的服事清單:")
        print(serve_list)
        # 取得用戶資料
        user_doc = db.collection("users").document(person_name).get()
        if not user_doc.exists:
            print(f"用戶 {person_name} 不存在於 users collection")
            continue
        
        user_data = user_doc.to_dict()
        line_id = user_data.get('lineId', '')
        
        if not line_id:
            print(f"用戶 {person_name} 沒有綁定 LINE ID")
            continue
        
        # 檢查今天是否要提醒 (alarm_type 陣列，索引對應週一=0 到 週六=5)
        alarm_type = user_data.get('alarm_type', [])
        
        # 週日 (weekday=6) 不在 alarm_type 範圍內，跳過
        if today_weekday >= len(alarm_type):
            continue
        
        if not alarm_type[today_weekday]:
            continue
        
        # 4. 發送提醒訊息
        message = f"提醒你這週有服事喔!\n\n這週的服事（{this_sunday.replace('.', '/')}）:\n"
        message += "\n".join([f"• {s}" for s in serve_list])
        
        try:
            line_bot_api.push_message(line_id, TextSendMessage(text=message))
            print(f"已提醒 {person_name}")
        except Exception as e:
            print(f"發送訊息給 {person_name} 失敗:", str(e))


def force_reminder(nextSunday, channel_access_token, service_prefix):
    #主領
    line_bot_api = LineBotApi(channel_access_token)
    nextSunday_docs = db.collection(f"{service_prefix}serve").document(nextSunday).get()
    if nextSunday_docs.exists:
        docs = db.collection(f"{service_prefix}user").document(nextSunday_docs.to_dict()['主領']).get()
        if docs.exists:
            lineId = docs.to_dict()['lineId']
            message=f'提醒你是下下週({nextSunday[5:].replace(".","/")})的主領，請記得選歌!'
            try:
                line_bot_api.push_message(lineId, TextSendMessage(text=message))
                print("Message sent successfully")
            except Exception as e:
                print("Failed to send message:", str(e))

def force_reminder(nextSunday, channel_access_token, service_prefix, serve_type, do_what):
    line_bot_api = LineBotApi(channel_access_token)
    nextSunday_docs = db.collection(f"{service_prefix}serve").document(nextSunday).get()
    if nextSunday_docs.exists:
        docs = db.collection(f"{service_prefix}user").document(nextSunday_docs.to_dict()[serve_type]).get()
        if docs.exists:
            lineId = docs.to_dict()['lineId']
            message=f'提醒你是下下週({nextSunday[5:].replace(".","/")})的{serve_type}，請記得{do_what}!'
            try:
                line_bot_api.push_message(lineId, TextSendMessage(text=message))
                print("Message sent successfully")
            except Exception as e:
                print("Failed to send message:", str(e))

def cloud_Scheduler(request):
    # 检查请求方法是否为POST
    if request.method == 'POST':
        # 解析Cloud Scheduler POST请求的JSON数据
        request_json = request.get_json()

        # 在这里可以执行任何您想要的操作，例如打印请求数据或将其传递给其他服务。
        function=request_json.get("func")

        if function=="reminder":
            reminder_all_serves()

            # # 強制提醒主領、兒崇奉獻
            # if datetime.now().isoweekday() == 1:
            #     #找到下下個週日
            #     addDays=14-datetime.now().isoweekday()
            #     nextSunday=(datetime.now()+timedelta(days=addDays)).strftime("%Y.%m.%d")
            #     force_reminder(nextSunday, channel_access_token_adult, 'adult_', '主領', '選歌')
            #     force_reminder(nextSunday, channel_access_token_kids, 'kids_', '主領', '選歌')
            #     force_reminder(nextSunday, channel_access_token_youth, '', '主領', '選歌')
            #     force_reminder(nextSunday, channel_access_token_kids, 'kids_', '司會', '選經文')
        
        return "success"