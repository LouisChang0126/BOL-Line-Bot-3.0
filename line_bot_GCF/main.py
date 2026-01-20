"""
This is the main file of the line bot, which is deployed on Google Cloud Function.
"""

from chatBotConfig import channel_secret, channel_access_token
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
#firestore
import firebase_admin
from firebase_admin import credentials
from firebase_admin import firestore
cred = credentials.Certificate('../serviceAccount.json')
firebase_admin.initialize_app(cred)
db = firestore.client()

handler = WebhookHandler(channel_secret)
line_bot_api = LineBotApi(channel_access_token)

def is_sign_in(lineId):
    # 是否有登入
    query = db.collection("users").where("lineId", "==", lineId).limit(1)
    docs = query.get()
    if len(docs) > 0 and docs[0].exists:
        return True
    return False

def sign_in(name, lineId):
    #登入
    account=db.collection("users").document(name).get()
    if account.exists and account.to_dict()['lineId']=='':
        lib={"lineId":lineId,
            "alarm_type":[True, False, False, False, False, False]}
        db.collection("users").document(name).set(lib, merge=True)
        return True
    return False

def can_shift(lineId, mode):
    #查詢是否可以調班，如果只有一個服事且非招待或愛宴，直接跳過選服事
    serve_list = db.collection("users").where("lineId", "==", lineId).limit(1).get()[0].to_dict()['serve_types']
    if len(serve_list)==0:
        TextSendMessage(text="目前沒有服事喔~")
    elif len(serve_list)==1:
        if serve_list[0]=='招待' or serve_list[0]=='愛宴' or serve_list[0]=='貝斯' or serve_list[0]=='吉他':
            return TextSendMessage(text="目前不提供招待組長、愛宴組長、貝斯、吉他的換班或代班功能")
        else:
            return shift_Z([mode, serve_list[0]], lineId)
    else:
        return TemplateSendMessage(alt_text='調班選單', template=CarouselTemplate(shift_0(lineId, mode)))

def shift_0(lineId, mode):
    #調班_找使用者的所有服事
    #查詢中文名、服事種類
    if mode == 'G': mode_text = '選擇你要代班的服事種類'#grant
    else: mode_text = '選擇你要調班的服事種類'#shift
    
    docs = db.collection("users").where("lineId", "==", lineId).limit(1).get()[0]
    Chinese = docs.id
    doc=docs.to_dict()
    serve_list = doc['serve_types']
    columns=[]
    refresh_doc={}
    need_remove_serve=[]
    action_S=[]
    for serve_type in serve_list:
        need_remove_date=[]
        for day in doc[serve_type]:
            if day<datetime.now().strftime("%Y.%m.%d"):
                need_remove_date.append(day)
        if len(need_remove_date)<len(doc[serve_type]):
            action_S.append(PostbackTemplateAction(
                label=serve_type,
                text=serve_type,
                data=f"A*{mode}+{serve_type}")
            )
        else:
            need_remove_serve.append(serve_type)
            
        if len(need_remove_date):
            refresh_doc[serve_type]=[x for x in doc[serve_type] if x not in need_remove_date]
        
        if len(action_S)==3:
            columns.append(CarouselColumn(
                title='服事種類',
                text=mode_text,
                actions=action_S
            ))
            action_S=[]
    if len(action_S)!=0:
        while len(action_S)<3:
            action_S.append(PostbackTemplateAction(
                label=' ',
                text=' ',
                data=' ')
            )
        columns.append(CarouselColumn(
            title='服事種類',
            text=mode_text,
            actions=action_S
        ))
    if len(need_remove_serve):
        refresh_doc["serve_types"]=[x for x in serve_list if x not in need_remove_serve]
    if len(refresh_doc):
        db.collection("users").document(Chinese).set(refresh_doc, merge=True)
    return columns

def shift_1(lineId, mode, serve_type):
    #調班_找一個服事的所有日期
    mode_text = '選擇你要代班的服事日期' if mode == 'G' else '選擇你要調班的服事日期'
    
    docs = db.collection("users").where("lineId", "==", lineId).limit(1).get()[0]
    Chinese = docs.id
    doc=docs.to_dict()
    columns=[]
    action_S=[]
    for day in doc[serve_type]:
        action_S.append(PostbackTemplateAction(
            label=day.replace('.', '/'),
            text=day.replace('.', '/')+serve_type,
            data=f"A&{mode}+{day}+{serve_type}+{Chinese}")
        )

        if len(action_S)==3:
            columns.append(CarouselColumn(
                title=serve_type,
                text=mode_text,
                actions=action_S
            ))
            action_S=[]
    if len(action_S)!=0:
        while len(action_S)<3:
            action_S.append(PostbackTemplateAction(
                label=' ',
                text=' ',
                data=' ')
            )
        columns.append(CarouselColumn(
            title=serve_type,
            text=mode_text,
            actions=action_S
        ))
    return columns

def grant_person(change_date, serve_type, Chinese):
    docs = db.collection("service").limit(52).get()
    can_grant=set()
    for doc in docs:
        if len(doc.to_dict()[serve_type])==2:
            can_grant.add(doc.to_dict()[serve_type])
        elif len(doc.to_dict()[serve_type])==5:
            can_grant.add(doc.to_dict()[serve_type][0:2])
            can_grant.add(doc.to_dict()[serve_type][3:5])
    action_S=[]
    action_R=[]
    for person in can_grant:
        person_info = db.collection("users").document(person).get()
        if Chinese != person and person_info.exists and person_info.to_dict()['lineId'] != "":
            respondent=person
            action_S.append(PostbackTemplateAction(
                    label=respondent,
                    text=f"請{respondent}代班",
                    data=f"G#{respondent}+{change_date}+{serve_type}+{Chinese}")
                )
            if len(action_S)==3:
                action_R.append(CarouselColumn(
                    title='請誰代班?',
                    text='請"一定要"與該同工先私訊溝通好',
                    actions=action_S
                ))
                action_S=[]
    if len(action_S)!=0:
        while len(action_S)<3:
            action_S.append(PostbackTemplateAction(
                label=' ',
                text=' ',
                data=' ')
            )
        action_R.append(CarouselColumn(
            title='請誰代班?',
            text='請"一定要"與該同工先私訊溝通好',
            actions=action_S
        ))
    elif len(action_R)==0:
        action_S=[PostbackTemplateAction(
                label='這項服事的其他同工',
                text=' ',
                data=' '),
                    PostbackTemplateAction(
                label='還沒有註冊喔!',
                text=' ',
                data=' '),
                    PostbackTemplateAction(
                label='分享系統給他們吧!',
                text=' ',
                data=' ')]
        action_R.append(CarouselColumn(
            title='請誰代班?',
            text='請"一定要"與該同工先私訊溝通好',
            actions=action_S
        ))
    return action_R
        
def shift_2(change_date, serve_type, Chinese):
    docs = db.collection("service").limit(26).get()
    #.where(serve_type, "!=", Chinese)->這一直出問題
    action_S=[]
    action_R=[]
    if len(docs)>0:
        for doc in docs:
            respondent=doc.to_dict()[serve_type]
            if Chinese not in respondent:
                datee=doc.id.replace('.', '/')
                data_2='B#'if '/' in respondent else 'B&'
                action_S.append(PostbackTemplateAction(
                    label=f"{datee[5:]} {respondent}",
                    text=f"與{respondent}調班{datee[5:]}",
                    data=f"{data_2+datee}+{respondent}+{change_date}+{serve_type}+{Chinese}")
                )
                if len(action_S)==3:
                    action_R.append(CarouselColumn(
                        title='想換哪一天?',
                        text='請與該同工先私訊溝通好',
                        actions=action_S
                    ))
                    action_S=[]
        if len(action_S)!=0:
            while len(action_S)<3:
                action_S.append(PostbackTemplateAction(
                    label=' ',
                    text=' ',
                    data=' ')
                )
            action_R.append(CarouselColumn(
                title='想換哪一天?',
                text='請與該同工先私訊溝通好',
                actions=action_S
            ))
        return action_R
    else:
        return [PostbackTemplateAction(
                    label="error",
                    text=' ',
                    data=' ')]
    
def shift_3(docu_ID):
    docu=db.collection("_shift").document(docu_ID).get().to_dict()
    #確認沒有跟第三人換班過
    today=datetime.now().strftime("%Y.%m.%d")
    check_1=db.collection("service").document(docu['申請日']).get().to_dict()[docu['種類']]
    if docu['被申請日']!='none':
        check_2=db.collection("service").document(docu['被申請日']).get().to_dict()[docu['種類']]
    if ((docu['申請人'] in check_1) and docu['申請日']>=today and \
        (docu['被申請日']=='none' or ((docu['被申請人'] in check_2) and docu['被申請日']>=today))):
        #改申請日期端
        day1_doc={}
        day1_doc[docu['種類']]=check_1.replace(docu['申請人'], docu['被申請人'])
        db.collection("service").document(docu['申請日']).set(day1_doc, merge=True)
        #改被申請日期端
        if docu['被申請日']!='none':
            day2_doc={}
            day2_doc[docu['種類']]=check_2.replace(docu['被申請人'], docu['申請人'])
            db.collection("service").document(docu['被申請日']).set(day2_doc, merge=True)
        return True
    else:
        return False

def remind_sameWeek_serve(Chinese,date):
    docu = db.collection("users").document(Chinese).get().to_dict()
    remind_list=[]
    for serve_type in docu['serve_types']:
            if date in docu[serve_type]:
                remind_list.append(serve_type)
    if docu['in_kids_worship']:
        k_docu = db.collection("kids_user").document(Chinese).get().to_dict()
        for serve_type in k_docu['serve_types']:
            if date in k_docu[serve_type]:
                remind_list.append('兒崇:'+serve_type)
    if docu['in_youth_worship']:
        k_docu = db.collection("user").document(Chinese).get().to_dict()
        for serve_type in k_docu['serve_types']:
            if date in k_docu[serve_type]:
                remind_list.append('青崇:'+serve_type)
    if len(remind_list):
        textA="提醒你換班後那週還有：\n"
        for serve in remind_list:
            if textA[-1]=='"':
                textA+='、'
            textA+=f'"{serve}"'
        textA+="的服事喔，\n請衡量是否可以同時進行"
        return textA
    else:
        return "nothing"

def shift_Z(dfgh, lineId):
    return TemplateSendMessage(alt_text='哪天需要調班/代班', template=CarouselTemplate(shift_1(lineId, dfgh[0], dfgh[1])))
    
def shift_A(dfgh):
    if dfgh[0] == 'G':
        return TemplateSendMessage(alt_text='要請誰代班你的服事?', template=CarouselTemplate(grant_person(dfgh[1], dfgh[2], dfgh[3])))
    else:
        return TemplateSendMessage(alt_text='要跟誰換哪天?', template=CarouselTemplate(shift_2(dfgh[1], dfgh[2], dfgh[3])))
    
def shift_B(command, mode):
    dfgh=command[2:].split("+")
    if mode == 'G':
        mode_title = '代班'#grant
        mode_text = f"確定要把{dfgh[1][5:].replace('.', '/')}的{dfgh[2]}\n給{dfgh[0]}代班嗎?"#grant
        mode_data = f'G&{command[2:]}'#B, date,type,A
        replyMessage2="nothing"
    else:
        mode_title = '調班'
        mode_text = f"確定要用{dfgh[2][5:].replace('.', '/')}的{dfgh[3]}\n跟{dfgh[1]}換{dfgh[0][5:]}的嗎?"#shift
        mode_data = f'C&{command[2:]}'
        replyMessage2=remind_sameWeek_serve(dfgh[4], dfgh[0].replace('/', '.'))
        
    replyMessages = TemplateSendMessage(alt_text=f'確定要{mode_title}嗎?',
                            template=ButtonsTemplate(
                            title=f'確定要申請{mode_title}嗎?',
                            text=mode_text,
                            actions=[
                                PostbackTemplateAction(
                                    label='確定',
                                    text='確定',
                                    data=mode_data
                                )
                            ]
                        )
                    )
    
    if replyMessage2!="nothing":
        return [TextSendMessage(text = replyMessage2), replyMessages]
    else:
        return replyMessages


def shift_B_twoUser(dfgh):
    names=dfgh[1].split("/")
    return TemplateSendMessage(alt_text='選一個人喔',
                        template=ButtonsTemplate(
                        title=f"{dfgh[0][5:]}的哪個{dfgh[3]}?",
                        text='只能申請跟一個人調班~',
                        actions=[
                            PostbackTemplateAction(
                                label=names[0],
                                text=f'選{names[0]}',
                                data=f"B&{dfgh[0]}+{names[0]}+{dfgh[2]}+{dfgh[3]}+{dfgh[4]}"
                            ),
                            PostbackTemplateAction(
                                label=names[1],
                                text=f'選{names[1]}',
                                data=f"B&{dfgh[0]}+{names[1]}+{dfgh[2]}+{dfgh[3]}+{dfgh[4]}"
                            )
                        ]
                    )
                )

def shift_C(command, mode):
    dfgh=command[2:].split("+")
    if mode == 'G':
        receiverId=db.collection("users").document(dfgh[0]).get().to_dict()['lineId']
        switchcase = {"狀態": '等待', "種類": dfgh[2], "申請人": dfgh[3], "被申請人": dfgh[0], "申請日": dfgh[1], "被申請日": 'none'}
        pre_text = f"{dfgh[3]}想要請你幫忙代班\n{dfgh[1][5:].replace('.', '/')}的{dfgh[2]}\n是否同意代班?"
        SendMessage2="nothing"
    else:
        receiverId=db.collection("users").document(dfgh[1]).get().to_dict()['lineId']
        switchcase = {"狀態": '等待', "種類": dfgh[3], "申請人": dfgh[4], "被申請人": dfgh[1], "申請日": dfgh[2], "被申請日": dfgh[0].replace('/', '.')}
        pre_text = f"{dfgh[4]}想要用{dfgh[2][5:].replace('.', '/')}的{dfgh[3]}\n跟您換{dfgh[0][5:]}\n是否同意調班?"
        SendMessage2=remind_sameWeek_serve(dfgh[1],dfgh[2])
    if len(receiverId):
        #把調班資訊儲存到firestore
        update_time, case_ref = db.collection("_shift").add(switchcase)
        #設置按鈕訊息
        SendMessages=TemplateSendMessage(alt_text='要調班/代班嗎?',template=ConfirmTemplate(
                        text=pre_text,
                        actions=[
                            PostbackTemplateAction(
                                label='是',
                                text='是',
                                data='D&'+case_ref.id
                            ),
                            PostbackTemplateAction(
                                label='否',
                                text='否',
                                data='E&'+case_ref.id
                            )
                        ]
            )
        )
        
        if SendMessage2!="nothing":
            SendMessages=[SendMessages, TextSendMessage(text = SendMessage2)]
            
        line_bot_api.push_message(receiverId, SendMessages)
        return TextSendMessage(text="已詢問對方，確定後會再通知您")
    else:
        return TextSendMessage(text="該用戶還沒有註冊喔!快把系統分享給他吧!")

def shift_D(command):
    docu=db.collection("_shift").document(command[2:]).get().to_dict()
    if docu['被申請日']!='none':
        pre_text = '調班'
    else:
        pre_text = '代班'
    if docu["狀態"]=='等待':
        return TemplateSendMessage(alt_text=f'確定要{pre_text}嗎?',
                        template=ButtonsTemplate(
                        title=f'確定要{pre_text}嗎?',
                        text=f'不確定可以跳過,回到"是否同意{pre_text}"',
                        actions=[
                            PostbackTemplateAction(
                                label='確定',
                                text='確定',
                                data='F&'+command[2:]
                            )
                        ]
                    )
                )
    elif docu["狀態"]=='拒絕':
        return TextSendMessage(text="已拒絕後不能更改")
    else:
        return TextSendMessage(text=f"已成功{pre_text}過了")
    
def shift_E(command):
    docu=db.collection("_shift").document(command[2:]).get().to_dict()
    if docu["狀態"]=='等待':
        lib={"狀態":'拒絕'}
        db.collection("_shift").document(command[2:]).set(lib, merge=True)
        #主動推播回應申請人
        replyId=db.collection("users").document(docu['申請人']).get().to_dict()['lineId']
        if docu['被申請日']=='none':
            pre_text = f"之前申請請{docu['被申請人']}\n代班{docu['申請日'][5:].replace('.', '/')}的{docu['種類']}\
被對方「拒絕」\n請先跟對方私訊溝通好再申請,謝謝"
        else:
            pre_text = f"之前申請用{docu['申請日'][5:].replace('.', '/')}的{docu['種類']}\n\
與{docu['被申請人']}調班{docu['被申請日'][5:].replace('.', '/')}被對方「拒絕」\n請先跟對方私訊溝通好再申請,謝謝"
        line_bot_api.push_message(replyId, TextSendMessage(text=pre_text))
        return TextSendMessage(text="已拒絕申請")
    elif docu["狀態"]=='拒絕':
        return TextSendMessage(text="已拒絕申請過了")
    else:
        return TextSendMessage(text="已經調班/代班後不能更改")

def shift_F(command):
    docu=db.collection("_shift").document(command[2:]).get().to_dict()
    if docu["狀態"]=='等待':
        #執行調班
        if shift_3(command[2:]):
            lib={"狀態":'成功'}
            db.collection("_shift").document(command[2:]).set(lib, merge=True)
            #主動推播回應申請人
            if docu['被申請日']=='none':
                pre_text = f"之前申請請{docu['被申請人']}代班\n{docu['申請日'][5:].replace('.', '/')}的{docu['種類']}\n「已成功代班」"
            else:
                pre_text = f"之前申請用{docu['申請日'][5:].replace('.', '/')}的{docu['種類']}\n\
與{docu['被申請人']}調班{docu['被申請日'][5:].replace('.', '/')}\n「已成功調班」"
            rtn = "已成功調班/代班"
        else:
            lib={"狀態":'拒絕'}
            db.collection("_shift").document(command[2:]).set(lib, merge=True)
            #主動推播回應申請人
            if docu['被申請日']=='none':
                pre_text = f"之前申請請{docu['被申請人']}代班\n{docu['申請日'][5:].replace('.', '/')}的{docu['種類']}\n因你已經跟第三人調班了\n「代班失敗」"
            else:
                pre_text = f"之前申請用{docu['申請日'][5:].replace('.', '/')}的{docu['種類']}\n\
與{docu['被申請人']}調班{docu['被申請日'][5:].replace('.', '/')}\n因你或對方已經跟第三人調班了\n「調班失敗」"
            rtn = "你或對方已經跟第三人調班/代班了,此調班失敗"
        
        replyId=db.collection("users").document(docu['申請人']).get().to_dict()['lineId']
        line_bot_api.push_message(replyId, TextSendMessage(text=pre_text))
        return TextSendMessage(text=rtn)
    elif docu["狀態"]=='拒絕':
        return TextSendMessage(text="已拒絕後不能更改")
    else:
        return TextSendMessage(text="已成功調班過了")

def change_reminder_day(command, lineId):
    docs = db.collection("users").where("lineId", "==", lineId).limit(1).get()[0]
    Chinese = docs.id
    settings = docs.to_dict()['alarm_type']
    settings[int(command[2:3])-1]=True if command[3:4]=='t' else False
    lib={"alarm_type":settings}
    db.collection("users").document(Chinese).set(lib, merge=True)
    no_remind = True
    return_msg = "已成功改成:\n"
    if settings[0]:
        return_msg=f"{return_msg}週一"
        no_remind = False
    if settings[1]:
        return_msg=f"{return_msg} 週二"
        no_remind = False
    if settings[2]:
        return_msg=f"{return_msg} 週三"
        no_remind = False
    if settings[3]:
        return_msg=f"{return_msg} 週四"
        no_remind = False
    if settings[4]:
        return_msg=f"{return_msg} 週五"
        no_remind = False
    if settings[5]:
        return_msg=f"{return_msg} 週六"
        no_remind = False
        
    if no_remind:
        return_msg = f"{return_msg}不提醒"
    else:
        return_msg = f"{return_msg}\n提醒你該週服事"
    return TextSendMessage(text=return_msg)

                    
def weekText():
    #把班表中當週的服事印出
    #設定週日下午6點換下一週的班表
    docu = db.collection("service").limit(1).get()[0]
    if docu.exists:
        doc=docu.to_dict()
        answer_weekText=f"{docu.id.replace('.', '/')}的服事\n\
主領:{doc['主領']}\n\
副主領:{doc['副主領']}\n\
助唱:{doc['助唱']}\n\
司琴:{doc['司琴']}\n\
鼓手:{doc['鼓手']}\n"
        if '貝斯' in doc and doc['貝斯']!=' ':
            answer_weekText=f"{answer_weekText}貝斯:{doc['貝斯']}\n"
        elif '吉他' in doc and doc['吉他']!=' ':
            answer_weekText=f"{answer_weekText}吉他:{doc['吉他']}\n"
        answer_weekText=f"{answer_weekText}\
音控:{doc['音控']}\n\
彩排:{doc['彩排']}\n\n\
字幕:{doc['字幕1']}/{doc['字幕2']}\n\
司會:{doc['司會']}\n\
奉獻:{doc['奉獻']}\n\
招待:{doc['招待']}\n\
愛宴:{doc['愛宴']}\n\
會前(後):{doc['會前(後)']}\n\
新人:{doc['新人']}\n\
禱告:{doc['禱告']}"
        return TextSendMessage(text = answer_weekText)
    else:
        return TextSendMessage(text = 'error')

def wholeChart(lineId):
    Chinese=db.collection("users").where("lineId", "==", lineId).limit(1).get()[0].id
    return TextSendMessage(text = f"請點選連結(這是永久連結,可以用Google Chrome開)\nhttps://louischang0126.github.io/service/?user={Chinese}")

# (0) Messages
welcomeMessage = TextSendMessage(text='歡迎加入教會服事系統')
loginMessage = TextSendMessage(text='請先輸入你的名字登入(2個字)\n格式範例:阿光')
introMessage = TextSendMessage(text='介紹影片：\nhttps://youtu.be/xrBvmTZbiEY')
errorMessage = TextSendMessage(text='哦，這超出我的能力範圍......')
def alarmMessage():
    from week_alarm import alarm
    return FlexSendMessage(alt_text='提醒設定', contents= alarm)
def menuMessage():
    from week_alarm import menu
    return FlexSendMessage(alt_text='目錄', contents= menu)

# (1) Webhook
def lineWebhook(request):
    # get X-Line-Signature header value
    signature = request.headers.get('X-Line-Signature')
    # get request body as text
    body = request.get_data(as_text=True)
    # handle webhook body
    try:
        handler.handle(body, signature)
    except InvalidSignatureError as e:
        print(e)

    return '200 OK'

# (2) Follow Event
@handler.add(FollowEvent)
def handle_follow(event):
    replyMessages = [welcomeMessage, loginMessage, introMessage]
    line_bot_api.reply_message(event.reply_token, replyMessages)

# (3) Message Event
@handler.add(MessageEvent, message=TextMessage)
def handle_message(event):
    lineId = event.source.user_id
    command = event.message.text
    if is_sign_in(lineId):
        if (command in ['總班表','全部班表']):
            replyMessages = wholeChart(lineId)
        
        elif (command in ['班表','本週班表','當週班表','當周班表','本周班表']):
            replyMessages = weekText()
            
        elif (command in ['換班', '調班']):#選調班日、種類
            replyMessages = can_shift(lineId, 'S')
        
        elif (command in ['代班']):
            replyMessages = can_shift(lineId, 'G')
        
        elif (command in ['設定提醒', '提醒設定', '設定']):
            replyMessages = alarmMessage()
            
        elif (command in ['目錄', 'Menu', 'menu', '主選單', '選單']):
            replyMessages = menuMessage()
                
        else:
            return
    else:
        if (len(command) == 2):
            if sign_in(command, lineId):
                replyMessages = [TextSendMessage(text = "登入成功"),TextSendMessage(text = "手機請\"點按功能主選單\"\n平板或電腦請傳送「目錄」呼叫選單")]
            else:
                replyMessages = TextSendMessage(text = "登入失敗")

        else:
            replyMessages = [errorMessage, loginMessage]
                                                                                        
    line_bot_api.reply_message(event.reply_token, replyMessages)

# (4) Postback Event
@handler.add(PostbackEvent)
def handle_postback(event):
    print(event)
    lineId = event.source.user_id
    command = event.postback.data
    
    if (command[0:2] == 'A*'):#選調班日
        replyMessages = shift_Z(command[2:].split("+"), lineId)
    
    elif (command[0:2] == 'A&'):#選被調班日、被調班人
        replyMessages = shift_A(command[2:].split("+"))
        
    elif (command[0:2] == 'B&'):#跟調班人-確認申請
        replyMessages = shift_B(command, "S")
    
    elif (command[0:2] == 'B#'):#該服事有多人的處理
        replyMessages = shift_B_twoUser(command[2:].split("+"))
    
    elif (command[0:2] == 'G#'):#調班者代班-確認申請
        replyMessages = shift_B(command, "G")
        
    elif (command[0:2] == 'C&'):#被調班者-詢問
        replyMessages = shift_C(command, "S")
        
    elif (command[0:2] == 'G&'):#被調班者-詢問
        replyMessages = shift_C(command, "G")
        
    elif (command[0:2] == 'D&'):#被調班者-確認
        replyMessages = shift_D(command)
    
    elif (command[0:2] == 'E&'):#被調班者-拒絕
        replyMessages = shift_E(command)
        
    elif (command[0:2] == 'F&'):#被調班者-確認-成功
        replyMessages = shift_F(command)
        
    elif (command[0:2] == 'C*'):#更換服事提醒模式
        replyMessages = change_reminder_day(command, lineId)
                                                                                                                                                                     
    line_bot_api.reply_message(event.reply_token, replyMessages)