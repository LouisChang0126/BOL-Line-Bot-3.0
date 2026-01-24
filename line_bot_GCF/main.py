"""
LINE Bot 服事系統 - Google Cloud Function
提供教會服事系統的調班、代班、提醒等功能
支援多場崇拜 (multiple service collections)
"""

from chatBotConfig import channel_secret, channel_access_token, line_bot_id
from linebot import WebhookHandler, LineBotApi
from linebot.exceptions import InvalidSignatureError
from linebot.models import (
    FollowEvent,
    TextSendMessage,
    MessageEvent,
    TextMessage,
    PostbackEvent,
    ButtonsTemplate,
    TemplateSendMessage,
    PostbackTemplateAction,
    CarouselTemplate,
    CarouselColumn,
    ConfirmTemplate,
    FlexSendMessage,
    VideoSendMessage
)
from datetime import datetime, timedelta

# Firestore 初始化
import firebase_admin
from firebase_admin import credentials, firestore

cred = credentials.Certificate('serviceAccount.json')
firebase_admin.initialize_app(cred)
db = firestore.client()

# LINE Bot API 初始化
handler = WebhookHandler(channel_secret)
line_bot_api = LineBotApi(channel_access_token)


# =====================================================
# 使用者相關功能
# =====================================================

def is_signed_in(line_id):
    """
    檢查使用者是否已經登入（是否已綁定 LINE ID）
    
    Args:
        line_id: LINE 使用者 ID
        
    Returns:
        bool: 是否已登入
    """
    query = db.collection("users").where("lineId", "==", line_id).limit(1)
    docs = query.get()
    return len(docs) > 0 and docs[0].exists


def get_user_by_line_id(line_id):
    """
    根據 LINE ID 取得使用者資料
    
    Args:
        line_id: LINE 使用者 ID
        
    Returns:
        tuple: (使用者名稱, 使用者資料 dict) 或 (None, None)
    """
    docs = db.collection("users").where("lineId", "==", line_id).limit(1).get()
    if len(docs) > 0 and docs[0].exists:
        return docs[0].id, docs[0].to_dict()
    return None, None


def log_usage(user_name, action_type):
    """
    記錄使用者的使用量統計
    
    Args:
        user_name: 使用者名稱
        action_type: 操作類型 (如 "全部班表", "當週班表", "換班" 等)
    """
    if not user_name:
        return
    
    try:
        # 取得當前年月
        month_key = datetime.now().strftime("%Y.%m")
        
        # 使用 Firestore 的原子操作增加計數
        user_ref = db.collection("users").document(user_name)
        user_doc = user_ref.get()
        
        if user_doc.exists:
            user_data = user_doc.to_dict()
            usage_count = user_data.get('usage_count', {})
            
            if month_key not in usage_count:
                usage_count[month_key] = {}
            
            if action_type not in usage_count[month_key]:
                usage_count[month_key][action_type] = 0
            
            usage_count[month_key][action_type] += 1
            
            user_ref.update({'usage_count': usage_count})
    except Exception as e:
        print(f"log_usage error: {e}")


def sign_in_with_token(login_token, line_id):
    """
    使用邀請碼登入
    支援用戶換 LINE 帳號的情況，可以覆蓋舊的 LINE ID
    
    Args:
        login_token: 16位隨機邀請碼
        line_id: LINE 使用者 ID
        
    Returns:
        str or None: 登入成功返回使用者名稱，失敗返回 None
    """
    # 查詢是否有符合的邀請碼
    docs = db.collection("users").where("login_token", "==", login_token).limit(1).get()
    
    if len(docs) > 0 and docs[0].exists:
        user_name = docs[0].id
        user_data = docs[0].to_dict()
        old_line_id = user_data.get('lineId', '')
        
        # 更新 LINE ID 和 Line Bot ID
        update_data = {
            "lineId": line_id,
            "line_bot_id": line_bot_id,  # 更新為目前登入的 bot
        }
        
        # 只有首次登入才設定預設提醒
        if old_line_id == '':
            update_data["alarm_type"] = [True, False, False, False, False, False]  # 預設週一提醒
        
        db.collection("users").document(user_name).update(update_data)
        return user_name
    return None


# =====================================================
# 崇拜與服事項目相關功能
# =====================================================

def get_serve_list():
    """
    從 _config/serve-list 取得所有崇拜清單
    
    Returns:
        list: 崇拜清單 [{ id, name, emoji }, ...]
    """
    doc = db.collection("_config").document("serve-list").get()
    if doc.exists:
        return doc.to_dict().get('serves', [])
    return []


def get_serve_name_by_id(collection_id):
    """
    根據 collection ID 取得崇拜名稱
    
    Args:
        collection_id: 崇拜的 collection ID
        
    Returns:
        str: 崇拜名稱（含 emoji），如 "🎸 青年崇拜"
    """
    serves = get_serve_list()
    for serve in serves:
        if serve.get('id') == collection_id:
            return f"{serve.get('emoji', '')} {serve.get('name', collection_id)}"
    return collection_id


def get_service_items(collection_id):
    """
    從指定崇拜取得服事項目順序
    
    Args:
        collection_id: 崇拜的 collection ID
        
    Returns:
        list: 服事項目列表
    """
    doc = db.collection(collection_id).document("_metadata").get()
    if doc.exists:
        return doc.to_dict().get('serviceItems', [])
    return []


def get_user_serve_collections(user_data):
    """
    取得使用者參與的所有崇拜 collection ID
    
    Args:
        user_data: 使用者資料 dict
        
    Returns:
        dict: { collection_id: [服事項目列表], ... }
    """
    return user_data.get('serve_types', {})


def get_collection_schedule(collection_id):
    """
    取得崇拜 collection 中今天及之後的所有日期資料
    
    Args:
        collection_id: 崇拜的 collection ID
        
    Returns:
        dict: { 日期: { 服事項目: [人員列表], ... }, ... }
    """
    schedule = {}
    today = datetime.now().strftime("%Y.%m.%d")
    
    # 使用 document ID 篩選今天及之後的文件（最多半年份）
    docs = db.collection(collection_id) \
        .where("__name__", ">=", db.collection(collection_id).document(today)) \
        .limit(26).get()
    
    for doc in docs:
        # 跳過 _metadata 文件
        if doc.id == '_metadata':
            continue
        
        schedule[doc.id] = doc.to_dict()
    
    return schedule


def get_user_serve_dates_from_schedule(user_name, schedule, serve_type):
    """
    從班表資料中篩選使用者在指定服事項目的所有日期
    
    Args:
        user_name: 使用者名稱
        schedule: get_collection_schedule 回傳的班表資料
        serve_type: 服事種類
        
    Returns:
        list: 日期列表 (格式: YYYY.MM.DD)，已排序
    """
    dates = []
    for date, doc_data in schedule.items():
        persons = doc_data.get(serve_type, [])
        if user_name in persons:
            dates.append(date)
    
    return sorted(dates)


# =====================================================
# 調班/代班功能
# =====================================================

def can_shift(line_id, mode):
    """
    檢查是否可以調班/代班，並顯示選擇崇拜的選單
    
    Args:
        line_id: LINE 使用者 ID
        mode: 'S' (調班) 或 'G' (代班)
        
    Returns:
        LINE message 物件
    """
    user_name, user_data = get_user_by_line_id(line_id)
    if not user_data:
        return TextSendMessage(text="找不到使用者資料")
    
    serve_types = get_user_serve_collections(user_data)
    
    if not serve_types:
        return TextSendMessage(text="目前沒有服事喔~")
    
    # 收集所有有服事的崇拜和服事項目
    all_serves = []
    for collection_id, serve_list in serve_types.items():
        # 每個崇拜只查詢一次 Firestore
        schedule = get_collection_schedule(collection_id)
        
        for serve_type in serve_list:
            # 從現有的 schedule 中篩選服事日期
            dates = get_user_serve_dates_from_schedule(user_name, schedule, serve_type)
            if dates:
                all_serves.append({
                    'collection': collection_id,
                    'serve_type': serve_type,
                    'collection_name': get_serve_name_by_id(collection_id)
                })
    
    if not all_serves:
        return TextSendMessage(text="目前沒有未來的服事喔~")
    
    # 顯示選擇崇拜和服事類型的選單
    return TemplateSendMessage(
        alt_text='調班選單',
        template=CarouselTemplate(columns=build_serve_selection_columns(all_serves, mode))
    )


def build_serve_selection_columns(serves, mode):
    """
    建立選擇服事種類的 Carousel 選單
    
    Args:
        serves: 服事列表 [{ collection, serve_type, collection_name }, ...]
        mode: 'S' (調班) 或 'G' (代班)
        
    Returns:
        list: CarouselColumn 列表
    """
    mode_text = '選擇你要代班的服事種類' if mode == 'G' else '選擇你要調班的服事種類'
    
    columns = []
    actions = []
    
    for serve in serves:
        # 排除特定服事類型
        if serve['serve_type'] in ['招待', '愛宴', '貝斯', '吉他']:
            continue
            
        label = f"{serve['collection_name'][:6]}-{serve['serve_type'][:4]}"  # 限制長度
        text = f"{serve['collection_name']} {serve['serve_type']}"
        
        actions.append(PostbackTemplateAction(
            label=label[:12],  # LINE 限制 12 字元
            text=text[:60],
            data=f"A*{mode}+{serve['collection']}+{serve['serve_type']}"
        ))
        
        if len(actions) == 3:
            columns.append(CarouselColumn(
                title='服事種類',
                text=mode_text[:60],
                actions=actions
            ))
            actions = []
    
    # 處理剩餘的 actions
    if actions:
        while len(actions) < 3:
            actions.append(PostbackTemplateAction(label=' ', text=' ', data=' '))
        columns.append(CarouselColumn(
            title='服事種類',
            text=mode_text[:60],
            actions=actions
        ))
    
    return columns if columns else [CarouselColumn(
        title='無可用服事',
        text='目前沒有可調班的服事',
        actions=[PostbackTemplateAction(label=' ', text=' ', data=' ')] * 3
    )]


def select_shift_date(line_id, mode, collection_id, serve_type):
    """
    顯示選擇調班日期的選單
    
    Args:
        line_id: LINE 使用者 ID
        mode: 'S' (調班) 或 'G' (代班)
        collection_id: 崇拜 collection ID
        serve_type: 服事種類
        
    Returns:
        LINE message 物件
    """
    user_name, user_data = get_user_by_line_id(line_id)
    if not user_data:
        return TextSendMessage(text="找不到使用者資料")
    
    # 從崇拜 collection 取得該服事的日期列表
    schedule = get_collection_schedule(collection_id)
    dates = get_user_serve_dates_from_schedule(user_name, schedule, serve_type)
    
    if not dates:
        return TextSendMessage(text=f"目前沒有未來的 {serve_type} 服事日期")
    
    mode_text = '選擇你要代班的服事日期' if mode == 'G' else '選擇你要調班的服事日期'
    collection_name = get_serve_name_by_id(collection_id)
    
    columns = []
    actions = []
    
    for date in dates:
        actions.append(PostbackTemplateAction(
            label=date.replace('.', '/'),
            text=f"{date.replace('.', '/')} {serve_type}",
            data=f"A&{mode}+{date}+{collection_id}+{serve_type}+{user_name}"
        ))
        
        if len(actions) == 3:
            columns.append(CarouselColumn(
                title=f'{collection_name} - {serve_type}'[:40],
                text=mode_text[:60],
                actions=actions
            ))
            actions = []
    
    if actions:
        while len(actions) < 3:
            actions.append(PostbackTemplateAction(label=' ', text=' ', data=' '))
        columns.append(CarouselColumn(
            title=f'{collection_name} - {serve_type}'[:40],
            text=mode_text[:60],
            actions=actions
        ))
    
    return TemplateSendMessage(
        alt_text='哪天需要調班/代班',
        template=CarouselTemplate(columns=columns)
    )


def find_shift_candidates(collection_id, serve_type, change_date, requester_name, mode):
    """
    尋找可以調班/代班的人選
    
    Args:
        collection_id: 崇拜 collection ID
        serve_type: 服事種類
        change_date: 要調換的日期
        requester_name: 申請人名稱
        mode: 'S' (調班) 或 'G' (代班)
        
    Returns:
        list: CarouselColumn 列表
    """
    columns = []
    actions = []
    
    if mode == 'G':
        # 代班模式：找所有有這個服事的人
        users_query = db.collection("users").get()
        for user_doc in users_query:
            if user_doc.id == requester_name:
                continue
            user_data = user_doc.to_dict()
            serve_types = user_data.get('serve_types', {}).get(collection_id, [])
            if serve_type in serve_types and user_data.get('lineId', ''):
                actions.append(PostbackTemplateAction(
                    label=user_doc.id,
                    text=f"請 {user_doc.id} 代班",
                    data=f"G#{user_doc.id}+{change_date}+{collection_id}+{serve_type}+{requester_name}"
                ))
                if len(actions) == 3:
                    columns.append(CarouselColumn(
                        title='請誰代班?',
                        text='請「一定要」與該同工先私訊溝通好',
                        actions=actions
                    ))
                    actions = []
    else:
        # 調班模式：找該服事其他日期的人
        docs = db.collection(collection_id).limit(26).get()
        for doc in docs:
            if doc.id == '_metadata' or doc.id == change_date:
                continue
            doc_data = doc.to_dict()
            persons_list = doc_data.get(serve_type, [])
            
            # 檢查申請人是否不在這天的服事中
            if requester_name not in persons_list and len(persons_list) > 0:
                date_str = doc.id.replace('.', '/')
                persons_display = '/'.join(persons_list)  # 顯示用
                # 多人用 B#，單人用 B&
                data_prefix = 'B#' if len(persons_list) > 1 else 'B&'
                actions.append(PostbackTemplateAction(
                    label=f"{date_str[5:]} {persons_display}"[:12],
                    text=f"與 {persons_display} 調班 {date_str[5:]}",
                    data=f"{data_prefix}{date_str}+{persons_display}+{change_date}+{collection_id}+{serve_type}+{requester_name}"
                ))
                if len(actions) == 3:
                    columns.append(CarouselColumn(
                        title='想換哪一天?',
                        text='請與該同工先私訊溝通好',
                        actions=actions
                    ))
                    actions = []
    
    if actions:
        while len(actions) < 3:
            actions.append(PostbackTemplateAction(label=' ', text=' ', data=' '))
        columns.append(CarouselColumn(
            title='請誰代班?' if mode == 'G' else '想換哪一天?',
            text='請「一定要」與該同工先私訊溝通好' if mode == 'G' else '請與該同工先私訊溝通好',
            actions=actions
        ))
    
    if not columns:
        columns = [CarouselColumn(
            title='無可用人選',
            text='這項服事的其他同工還沒有註冊喔！分享系統給他們吧！',
            actions=[PostbackTemplateAction(label=' ', text=' ', data=' ')] * 3
        )]
    
    return columns


def confirm_shift_request(data_parts, mode):
    """
    確認調班/代班申請
    
    Args:
        data_parts: 解析後的資料
        mode: 'S' (調班) 或 'G' (代班)
        
    Returns:
        LINE message 物件
    """
    if mode == 'G':
        # 代班確認: [被申請人, 申請日, collection_id, 服事種類, 申請人]
        respondent, apply_date, collection_id, serve_type, requester = data_parts
        collection_name = get_serve_name_by_id(collection_id)
        confirm_text = f"確定要把 {apply_date[5:].replace('.', '/')} 的 {serve_type}\n給 {respondent} 代班嗎?\n({collection_name})"
        data = f"G&{'+'.join(data_parts)}"
        mode_title = '代班'
        remind_msg = None
    else:
        # 調班確認: [被申請日, 被申請人, 申請日, collection_id, 服事種類, 申請人]
        target_date, respondent, apply_date, collection_id, serve_type, requester = data_parts
        collection_name = get_serve_name_by_id(collection_id)
        confirm_text = f"確定要用 {apply_date[5:].replace('.', '/')} 的 {serve_type}\n跟 {respondent} 換 {target_date[5:]} 的嗎?\n({collection_name})"
        data = f"C&{'+'.join(data_parts)}"
        mode_title = '調班'
        remind_msg = remind_same_week_serve(requester, target_date.replace('/', '.'), collection_id)
    
    reply = TemplateSendMessage(
        alt_text=f'確定要{mode_title}嗎?',
        template=ButtonsTemplate(
            title=f'確定要申請{mode_title}嗎?',
            text=confirm_text[:60],
            actions=[PostbackTemplateAction(label='確定', text='確定', data=data)]
        )
    )
    
    if remind_msg:
        return [TextSendMessage(text=remind_msg), reply]
    return reply


def send_shift_request(data_parts, mode):
    """
    發送調班/代班請求給對方
    
    Args:
        data_parts: 解析後的資料
        mode: 'S' (調班) 或 'G' (代班)
        
    Returns:
        LINE message 物件
    """
    if mode == 'G':
        # 代班: [被申請人, 申請日, collection_id, 服事種類, 申請人]
        respondent, apply_date, collection_id, serve_type, requester = data_parts
        receiver_doc = db.collection("users").document(respondent).get()
        if not receiver_doc.exists:
            return TextSendMessage(text="該用戶不存在！")
        receiver_id = receiver_doc.to_dict().get('lineId', '')
        
        shift_record = {
            "狀態": '等待',
            "種類": serve_type,
            "collection": collection_id,
            "申請人": requester,
            "被申請人": respondent,
            "申請日": apply_date,
            "被申請日": 'none'
        }
        collection_name = get_serve_name_by_id(collection_id)
        request_text = f"{requester} 想要請你幫忙代班\n{apply_date[5:].replace('.', '/')} 的 {serve_type}\n({collection_name})\n是否同意代班?"
        remind_msg = None
    else:
        # 調班: [被申請日, 被申請人, 申請日, collection_id, 服事種類, 申請人]
        target_date, respondent, apply_date, collection_id, serve_type, requester = data_parts
        receiver_doc = db.collection("users").document(respondent).get()
        if not receiver_doc.exists:
            return TextSendMessage(text="該用戶不存在！")
        receiver_id = receiver_doc.to_dict().get('lineId', '')
        
        shift_record = {
            "狀態": '等待',
            "種類": serve_type,
            "collection": collection_id,
            "申請人": requester,
            "被申請人": respondent,
            "申請日": apply_date,
            "被申請日": target_date.replace('/', '.')
        }
        collection_name = get_serve_name_by_id(collection_id)
        request_text = f"{requester} 想要用 {apply_date[5:].replace('.', '/')} 的 {serve_type}\n跟您換 {target_date[5:]}\n({collection_name})\n是否同意調班?"
        remind_msg = remind_same_week_serve(respondent, apply_date, collection_id)
    
    if not receiver_id:
        return TextSendMessage(text="該用戶還沒有註冊喔！快把系統分享給他吧！")
    
    # 儲存調班記錄
    _, case_ref = db.collection("_shift").add(shift_record)
    
    # 發送請求給對方
    send_message = TemplateSendMessage(
        alt_text='要調班/代班嗎?',
        template=ConfirmTemplate(
            text=request_text[:240],
            actions=[
                PostbackTemplateAction(label='是', text='是', data=f'D&{case_ref.id}'),
                PostbackTemplateAction(label='否', text='否', data=f'E&{case_ref.id}')
            ]
        )
    )
    
    # 記錄收到調班/代班請求
    log_usage(respondent, '調班/代班請求')
    
    if remind_msg:
        line_bot_api.push_message(receiver_id, [send_message, TextSendMessage(text=remind_msg)])
    else:
        line_bot_api.push_message(receiver_id, send_message)
    
    return TextSendMessage(text="已詢問對方，確定後會再通知您")


def handle_shift_confirm(case_id):
    """
    處理被申請人確認調班/代班
    
    Args:
        case_id: 調班記錄 ID
        
    Returns:
        LINE message 物件
    """
    doc = db.collection("_shift").document(case_id).get()
    if not doc.exists:
        return TextSendMessage(text="找不到這筆調班記錄")
    
    data = doc.to_dict()
    mode_text = '調班' if data['被申請日'] != 'none' else '代班'
    
    if data["狀態"] == '等待':
        return TemplateSendMessage(
            alt_text=f'確定要{mode_text}嗎?',
            template=ButtonsTemplate(
                title=f'確定要{mode_text}嗎?',
                text=f'不確定可以跳過，回到「是否同意{mode_text}」',
                actions=[PostbackTemplateAction(label='確定', text='確定', data=f'F&{case_id}')]
            )
        )
    elif data["狀態"] == '拒絕':
        return TextSendMessage(text="已拒絕後不能更改")
    else:
        return TextSendMessage(text=f"已成功{mode_text}過了")


def handle_shift_reject(case_id):
    """
    處理被申請人拒絕調班/代班
    
    Args:
        case_id: 調班記錄 ID
        
    Returns:
        LINE message 物件
    """
    doc = db.collection("_shift").document(case_id).get()
    if not doc.exists:
        return TextSendMessage(text="找不到這筆調班記錄")
    
    data = doc.to_dict()
    
    if data["狀態"] == '等待':
        db.collection("_shift").document(case_id).update({"狀態": '拒絕'})
        
        # 通知申請人
        requester_doc = db.collection("users").document(data['申請人']).get()
        if requester_doc.exists:
            requester_id = requester_doc.to_dict().get('lineId', '')
            collection_name = get_serve_name_by_id(data.get('collection', ''))
            
            if data['被申請日'] == 'none':
                notify_text = f"之前申請請 {data['被申請人']}\n代班 {data['申請日'][5:].replace('.', '/')} 的 {data['種類']}\n({collection_name})\n被對方「拒絕」\n請先跟對方私訊溝通好再申請，謝謝"
            else:
                notify_text = f"之前申請用 {data['申請日'][5:].replace('.', '/')} 的 {data['種類']}\n與 {data['被申請人']} 調班 {data['被申請日'][5:].replace('.', '/')}\n({collection_name})\n被對方「拒絕」\n請先跟對方私訊溝通好再申請，謝謝"
            
            if requester_id:
                line_bot_api.push_message(requester_id, TextSendMessage(text=notify_text))
        
        return TextSendMessage(text="已拒絕申請")
    elif data["狀態"] == '拒絕':
        return TextSendMessage(text="已拒絕申請過了")
    else:
        return TextSendMessage(text="已經調班/代班後不能更改")


def execute_shift(case_id):
    """
    執行調班/代班
    
    Args:
        case_id: 調班記錄 ID
        
    Returns:
        LINE message 物件
    """
    doc = db.collection("_shift").document(case_id).get()
    if not doc.exists:
        return TextSendMessage(text="找不到這筆調班記錄")
    
    data = doc.to_dict()
    
    if data["狀態"] != '等待':
        if data["狀態"] == '拒絕':
            return TextSendMessage(text="已拒絕後不能更改")
        return TextSendMessage(text="已成功調班過了")
    
    collection_id = data.get('collection', 'service')  # 相容舊資料
    serve_type = data['種類']
    today = datetime.now().strftime("%Y.%m.%d")
    
    # 檢查並執行調班
    apply_doc = db.collection(collection_id).document(data['申請日']).get()
    if not apply_doc.exists:
        return TextSendMessage(text="找不到申請日的服事資料")
    
    apply_data = apply_doc.to_dict()
    apply_persons = apply_data.get(serve_type, [])
    
    # 檢查申請人是否還在申請日的服事中（直接檢查陣列）
    if data['申請人'] not in apply_persons or data['申請日'] < today:
        db.collection("_shift").document(case_id).update({"狀態": '拒絕'})
        notify_requester_failure(data, "因時間已過或你已經跟第三人調班了")
        return TextSendMessage(text="你或對方已經跟第三人調班/代班了，此調班失敗")
    
    if data['被申請日'] != 'none':
        # 調班模式
        target_doc = db.collection(collection_id).document(data['被申請日']).get()
        if not target_doc.exists:
            return TextSendMessage(text="找不到被申請日的服事資料")
        
        target_data = target_doc.to_dict()
        target_persons = target_data.get(serve_type, [])
        
        # 檢查被申請人是否還在被申請日的服事中（直接檢查陣列）
        if data['被申請人'] not in target_persons or data['被申請日'] < today:
            db.collection("_shift").document(case_id).update({"狀態": '拒絕'})
            notify_requester_failure(data, "因對方已經跟第三人調班了")
            return TextSendMessage(text="你或對方已經跟第三人調班/代班了，此調班失敗")
        
        # 執行調班
        new_apply = [data['被申請人'] if p == data['申請人'] else p for p in apply_persons]
        new_target = [data['申請人'] if p == data['被申請人'] else p for p in target_persons]
        
        db.collection(collection_id).document(data['申請日']).update({serve_type: new_apply})
        db.collection(collection_id).document(data['被申請日']).update({serve_type: new_target})
    else:
        # 代班模式
        new_apply = [data['被申請人'] if p == data['申請人'] else p for p in apply_persons]
        db.collection(collection_id).document(data['申請日']).update({serve_type: new_apply})
    
    # 更新狀態
    db.collection("_shift").document(case_id).update({"狀態": '成功'})
    
    # 通知申請人成功
    notify_requester_success(data)
    
    return TextSendMessage(text="已成功調班/代班")


def notify_requester_success(data):
    """通知申請人調班成功"""
    requester_doc = db.collection("users").document(data['申請人']).get()
    if requester_doc.exists:
        requester_id = requester_doc.to_dict().get('lineId', '')
        collection_name = get_serve_name_by_id(data.get('collection', ''))
        
        if data['被申請日'] == 'none':
            notify_text = f"之前申請請 {data['被申請人']} 代班\n{data['申請日'][5:].replace('.', '/')} 的 {data['種類']}\n({collection_name})\n「已成功代班」"
        else:
            notify_text = f"之前申請用 {data['申請日'][5:].replace('.', '/')} 的 {data['種類']}\n與 {data['被申請人']} 調班 {data['被申請日'][5:].replace('.', '/')}\n({collection_name})\n「已成功調班」"
        
        if requester_id:
            # 記錄調班/代班成功通知
            log_usage(data['申請人'], '調班/代班成功通知')
            line_bot_api.push_message(requester_id, TextSendMessage(text=notify_text))


def notify_requester_failure(data, reason):
    """通知申請人調班失敗"""
    requester_doc = db.collection("users").document(data['申請人']).get()
    if requester_doc.exists:
        requester_id = requester_doc.to_dict().get('lineId', '')
        collection_name = get_serve_name_by_id(data.get('collection', ''))
        
        if data['被申請日'] == 'none':
            notify_text = f"之前申請請 {data['被申請人']} 代班\n{data['申請日'][5:].replace('.', '/')} 的 {data['種類']}\n({collection_name})\n{reason}\n「代班失敗」"
        else:
            notify_text = f"之前申請用 {data['申請日'][5:].replace('.', '/')} 的 {data['種類']}\n與 {data['被申請人']} 調班 {data['被申請日'][5:].replace('.', '/')}\n({collection_name})\n{reason}\n「調班失敗」"
        
        if requester_id:
            line_bot_api.push_message(requester_id, TextSendMessage(text=notify_text))


def remind_same_week_serve(user_name, date, exclude_collection=None):
    """
    提醒使用者該週還有其他服事
    
    Args:
        user_name: 使用者名稱
        date: 日期 (格式: YYYY.MM.DD)
        exclude_collection: 要排除的 collection ID
        
    Returns:
        str or None: 提醒訊息，如果沒有則返回 None
    """
    user_doc = db.collection("users").document(user_name).get()
    if not user_doc.exists:
        return None
    
    user_data = user_doc.to_dict()
    remind_list = []
    
    serve_types = user_data.get('serve_types', {})
    for collection_id, serves in serve_types.items():
        # 直接取得該日期的文件
        doc = db.collection(collection_id).document(date).get()
        if not doc.exists:
            continue
        
        doc_data = doc.to_dict()
        collection_name = get_serve_name_by_id(collection_id)
        
        for serve in serves:
            # 檢查使用者是否在該日期有此服事
            persons = doc_data.get(serve, [])
            if user_name in persons:
                remind_list.append(f"{collection_name} - {serve}")
    
    if remind_list:
        text = "提醒你換班後那週還有：\n"
        text += "、\n".join([f'「{s}」' for s in remind_list])
        text += "\n的服事喔，請衡量是否可以同時進行"
        return text
    return None


def handle_two_person_shift(data_parts):
    """
    處理同一天有兩個人服事的情況
    
    Args:
        data_parts: [被申請日, 被申請人(含/), 申請日, collection_id, 服事種類, 申請人]
        
    Returns:
        LINE message 物件
    """
    target_date, persons, apply_date, collection_id, serve_type, requester = data_parts
    names = persons.split("/")
    
    return TemplateSendMessage(
        alt_text='選一個人喔',
        template=ButtonsTemplate(
            title=f"{target_date[5:]} 的哪個 {serve_type}?",
            text='只能申請跟一個人調班~',
            actions=[
                PostbackTemplateAction(
                    label=names[0],
                    text=f'選 {names[0]}',
                    data=f"B&{target_date}+{names[0]}+{apply_date}+{collection_id}+{serve_type}+{requester}"
                ),
                PostbackTemplateAction(
                    label=names[1],
                    text=f'選 {names[1]}',
                    data=f"B&{target_date}+{names[1]}+{apply_date}+{collection_id}+{serve_type}+{requester}"
                )
            ]
        )
    )


# =====================================================
# 提醒設定功能
# =====================================================

def change_reminder_day(command, line_id):
    """
    更改服事提醒日期設定
    
    Args:
        command: 指令 (格式: C*{1-6}{t/f})
        line_id: LINE 使用者 ID
        
    Returns:
        LINE message 物件
    """
    user_name, user_data = get_user_by_line_id(line_id)
    if not user_data:
        return TextSendMessage(text="找不到使用者資料")
    
    settings = user_data.get('alarm_type', [False] * 6)
    day_index = int(command[2:3]) - 1
    settings[day_index] = command[3:4] == 't'
    
    db.collection("users").document(user_name).update({"alarm_type": settings})
    
    days = ['週一', '週二', '週三', '週四', '週五', '週六']
    active_days = [days[i] for i, v in enumerate(settings) if v]
    
    if active_days:
        return_msg = f"已成功改成：\n{' '.join(active_days)}\n提醒你該週服事"
    else:
        return_msg = "已成功改成：\n不提醒"
    
    return TextSendMessage(text=return_msg)


# =====================================================
# 班表查詢功能
# =====================================================

def get_week_schedule_text(line_id, collection_id=None):
    """
    取得當週班表文字
    若用戶有多個崇拜的服事，則顯示選擇選單
    
    Args:
        line_id: LINE 使用者 ID
        collection_id: 崇拜 collection ID，若為 None 則自動判斷
        
    Returns:
        LINE message 物件
    """
    # 如果指定了 collection_id，直接顯示該崇拜的班表
    if collection_id:
        return build_schedule_message(collection_id)
    
    # 取得使用者資料，判斷參與幾個崇拜
    user_name, user_data = get_user_by_line_id(line_id)
    if not user_data:
        # 未登入的用戶，顯示第一個崇拜
        serves = get_serve_list()
        if not serves:
            return TextSendMessage(text="找不到任何崇拜資料")
        return build_schedule_message(serves[0].get('id'))
    
    # 取得使用者參與的崇拜
    serve_types = get_user_serve_collections(user_data)
    user_collections = list(serve_types.keys()) if serve_types else []
    
    if len(user_collections) == 0:
        # 用戶沒有任何服事，顯示第一個崇拜
        serves = get_serve_list()
        if not serves:
            return TextSendMessage(text="找不到任何崇拜資料")
        return build_schedule_message(serves[0].get('id'))
    
    elif len(user_collections) == 1:
        # 只有一個崇拜，直接顯示
        return build_schedule_message(user_collections[0])
    
    else:
        # 多個崇拜，顯示選擇選單
        return build_schedule_selection_menu(user_collections)


def build_schedule_selection_menu(collection_ids):
    """
    建立選擇崇拜的 Carousel 選單
    
    Args:
        collection_ids: 崇拜 collection ID 列表
        
    Returns:
        LINE TemplateSendMessage 物件
    """
    columns = []
    actions = []
    
    for collection_id in collection_ids:
        serve_name = get_serve_name_by_id(collection_id)
        actions.append(PostbackTemplateAction(
            label=serve_name[:12],  # LINE 限制 12 字元
            text=f"查看 {serve_name} 班表",
            data=f"W&{collection_id}"
        ))
        
        # 每 3 個 action 建立一個 column
        if len(actions) == 3:
            columns.append(CarouselColumn(
                title='選擇崇拜',
                text='請選擇要查看哪場崇拜的班表',
                actions=actions
            ))
            actions = []
    
    # 處理剩餘的 actions
    if actions:
        while len(actions) < 3:
            actions.append(PostbackTemplateAction(label=' ', text=' ', data=' '))
        columns.append(CarouselColumn(
            title='選擇崇拜',
            text='請選擇要查看哪場崇拜的班表',
            actions=actions
        ))
    
    return TemplateSendMessage(
        alt_text='選擇要查看的崇拜班表',
        template=CarouselTemplate(columns=columns)
    )


def build_schedule_message(collection_id):
    """
    建立單一崇拜的班表訊息
    
    Args:
        collection_id: 崇拜 collection ID
        
    Returns:
        LINE TextSendMessage 物件
    """
    # 取得服事項目順序
    service_items = get_service_items(collection_id)
    if not service_items:
        return TextSendMessage(text="找不到服事項目資料")
    
    # 取得當週班表
    today = datetime.now().strftime("%Y.%m.%d")
    docs = db.collection(collection_id).order_by("__name__").limit(5).get()
    
    schedule_doc = None
    for doc in docs:
        if doc.id != '_metadata' and doc.id >= today:
            schedule_doc = doc
            break
    
    if not schedule_doc:
        # 取最新的一筆
        for doc in docs:
            if doc.id != '_metadata':
                schedule_doc = doc
                break
    
    if not schedule_doc:
        return TextSendMessage(text="找不到班表資料")
    
    data = schedule_doc.to_dict()
    collection_name = get_serve_name_by_id(collection_id)
    
    text = f"{collection_name}\n{schedule_doc.id.replace('.', '/')} 的服事\n\n"
    
    for item in service_items:
        persons = data.get(item, [])
        if isinstance(persons, list):
            persons = '/'.join(persons) if persons else '-'
        text += f"{item}：{persons}\n"
    
    return TextSendMessage(text=text.strip())


def get_full_schedule_link(line_id):
    """
    取得完整班表連結
    
    Args:
        line_id: LINE 使用者 ID
        
    Returns:
        LINE message 物件
    """
    user_name, _ = get_user_by_line_id(line_id)
    if user_name:
        return TextSendMessage(
            text=f"請點選連結（這是永久連結，可以用 Google Chrome 開）\nhttps://bol-line-bot-3.web.app/?user={user_name}"
        )
    return TextSendMessage(text="請點選連結\nhttps://bol-line-bot-3.web.app/")


# =====================================================
# 訊息模板
# =====================================================

welcomeMessage = TextSendMessage(text='歡迎加入教會服事系統')
loginMessage = TextSendMessage(text='請輸入管理員給你的16位邀請碼登入\n格式範例：Abc123DEF456GHiJ')
introMessage = TextSendMessage(text='介紹影片：\nhttps://youtu.be/xrBvmTZbiEY')
errorMessage = TextSendMessage(text='哦，這超出我的能力範圍......')


def alarmMessage():
    """取得提醒設定 Flex Message"""
    from week_alarm import alarm
    return FlexSendMessage(alt_text='提醒設定', contents=alarm)


def menuMessage():
    """取得目錄 Flex Message"""
    from week_alarm import menu
    return FlexSendMessage(alt_text='目錄', contents=menu)


# =====================================================
# Webhook 處理
# =====================================================

def lineWebhook(request):
    """
    LINE Webhook 進入點
    
    Args:
        request: HTTP request 物件
        
    Returns:
        str: 回應訊息
    """
    signature = request.headers.get('X-Line-Signature')
    body = request.get_data(as_text=True)
    
    try:
        handler.handle(body, signature)
    except InvalidSignatureError as e:
        print(e)
    
    return '200 OK'


@handler.add(FollowEvent)
def handle_follow(event):
    """處理使用者加入好友事件"""
    replyMessages = [welcomeMessage, loginMessage, introMessage]
    line_bot_api.reply_message(event.reply_token, replyMessages)


@handler.add(MessageEvent, message=TextMessage)
def handle_message(event):
    """處理使用者文字訊息"""
    line_id = event.source.user_id
    command = event.message.text.strip()
    
    if is_signed_in(line_id):
        # 已登入使用者
        user_name, _ = get_user_by_line_id(line_id)
        
        if command in ['總班表', '全部班表']:
            log_usage(user_name, '全部班表')
            replyMessages = get_full_schedule_link(line_id)
        
        elif command in ['班表', '本週班表', '當週班表', '當周班表', '本周班表']:
            log_usage(user_name, '當週班表')
            replyMessages = get_week_schedule_text(line_id)
        
        elif command in ['換班', '調班']:
            log_usage(user_name, '換班')
            replyMessages = can_shift(line_id, 'S')
        
        elif command in ['代班']:
            log_usage(user_name, '代班')
            replyMessages = can_shift(line_id, 'G')
        
        elif command in ['設定提醒', '提醒設定', '設定']:
            log_usage(user_name, '設定提醒')
            replyMessages = alarmMessage()
        
        elif command in ['目錄', 'Menu', 'menu', '主選單', '選單']:
            log_usage(user_name, '目錄')
            replyMessages = menuMessage()
        
        else:
            return  # 不回應其他訊息
    else:
        # 未登入使用者 - 嘗試用邀請碼登入
        if len(command) == 16 and command.isalnum():
            user_name = sign_in_with_token(command, line_id)
            if user_name:
                replyMessages = [
                    TextSendMessage(text=f"登入成功！歡迎 {user_name}"),
                    TextSendMessage(text="手機請「點按功能主選單」\n平板或電腦請傳送「目錄」呼叫選單")
                ]
            else:
                replyMessages = TextSendMessage(text="登入失敗，邀請碼無效或已被使用")
        else:
            replyMessages = [errorMessage, loginMessage]
    
    line_bot_api.reply_message(event.reply_token, replyMessages)


@handler.add(PostbackEvent)
def handle_postback(event):
    """處理使用者 Postback 事件"""
    print(event)
    line_id = event.source.user_id
    command = event.postback.data
    
    if command.strip() == ' ' or command.strip() == '':
        return  # 空白按鈕不處理
    
    prefix = command[0:2]
    data = command[2:]
    
    if prefix == 'A*':
        # 選擇崇拜和服事種類後，顯示日期選單
        # data: {mode}+{collection}+{serve_type}
        parts = data.split('+')
        mode, collection_id, serve_type = parts[0], parts[1], parts[2]
        replyMessages = select_shift_date(line_id, mode, collection_id, serve_type)
    
    elif prefix == 'A&':
        # 選擇日期後，顯示候選人選單
        # data: {mode}+{date}+{collection}+{serve_type}+{user_name}
        parts = data.split('+')
        mode = parts[0]
        columns = find_shift_candidates(parts[2], parts[3], parts[1], parts[4], mode)
        replyMessages = TemplateSendMessage(
            alt_text='要跟誰換哪天?' if mode == 'S' else '要請誰代班你的服事?',
            template=CarouselTemplate(columns=columns)
        )
    
    elif prefix == 'B&':
        # 確認調班申請
        # data: {被申請日}+{被申請人}+{申請日}+{collection}+{serve_type}+{申請人}
        replyMessages = confirm_shift_request(data.split('+'), 'S')
    
    elif prefix == 'B#':
        # 該服事有多人的處理
        replyMessages = handle_two_person_shift(data.split('+'))
    
    elif prefix == 'G#':
        # 確認代班申請
        # data: {被申請人}+{申請日}+{collection}+{serve_type}+{申請人}
        replyMessages = confirm_shift_request(data.split('+'), 'G')
    
    elif prefix == 'C&':
        # 發送調班請求
        replyMessages = send_shift_request(data.split('+'), 'S')
    
    elif prefix == 'G&':
        # 發送代班請求
        replyMessages = send_shift_request(data.split('+'), 'G')
    
    elif prefix == 'D&':
        # 被申請人確認
        replyMessages = handle_shift_confirm(data)
    
    elif prefix == 'E&':
        # 被申請人拒絕
        replyMessages = handle_shift_reject(data)
    
    elif prefix == 'F&':
        # 執行調班/代班
        replyMessages = execute_shift(data)
    
    elif prefix == 'C*':
        # 更換服事提醒模式
        replyMessages = change_reminder_day(command, line_id)
    
    elif prefix == 'W&':
        # 查看指定崇拜的班表
        # data: {collection_id}
        replyMessages = build_schedule_message(data)
    
    else:
        return  # 不認識的指令不處理
    
    line_bot_api.reply_message(event.reply_token, replyMessages)