"""
Agent Schedule Generator - Google Cloud Function
Claude API Proxy for AI-powered scheduling
"""

import os
import json
import functions_framework
from flask import jsonify, make_response
import anthropic

# 讀取 API Key（優先從 agentConfig.py，fallback 到環境變數）
try:
    from agentConfig import ANTHROPIC_API_KEY
except ImportError:
    ANTHROPIC_API_KEY = os.environ.get('ANTHROPIC_API_KEY', '')

# CORS 白名單
ALLOWED_ORIGINS = [
    'https://bol-line-bot-3.web.app',
    'http://localhost:5500',   # 本地開發
]

def cors_response(data=None, status=200):
    """建立帶 CORS header 的回應"""
    if isinstance(data, dict):
        response = make_response(jsonify(data), status)
    else:
        response = make_response(data or '', status)
    return response

def add_cors_headers(response, origin):
    """加入 CORS headers"""
    if origin in ALLOWED_ORIGINS:
        response.headers['Access-Control-Allow-Origin'] = origin
    response.headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    response.headers['Access-Control-Max-Age'] = '3600'
    return response


# Claude Tool 定義：限制回傳 scheduleData 格式
SCHEDULE_TOOL = {
    "name": "update_schedule",
    "description": "更新排班表。請使用此工具回傳新的排班資料。每個日期的每個服事項目都是一個人名的陣列。",
    "input_schema": {
        "type": "object",
        "properties": {
            "scheduleData": {
                "type": "array",
                "description": "排班資料陣列，每個元素代表一週",
                "items": {
                    "type": "object",
                    "properties": {
                        "date": {
                            "type": "string",
                            "description": "日期字串，格式如 '2026-03-29'"
                        }
                    },
                    "additionalProperties": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "服事項目對應的人名陣列"
                    },
                    "required": ["date"]
                }
            },
            "addWeeks": {
                "type": "integer",
                "description": "要在班表最後面新增幾週？(例如 1 代表新增一週)。注意：新增的週會自動延續最後一週的日期。如果不需新增請填 0。"
            },
            "removeWeeks": {
                "type": "integer",
                "description": "要從班表最後面刪除幾週？(例如 1 代表刪除最後一週)。如果不需刪除請填 0。"
            },
            "addServiceColumns": {
                "type": "array",
                "items": {"type": "string"},
                "description": "要新增的服事或資訊欄位名稱清單。例如 ['音控', '注意事項']。不需新增請保持空陣列。"
            },
            "removeServiceColumns": {
                "type": "array",
                "items": {"type": "string"},
                "description": "要刪除的服事或資訊欄位名稱清單。不需刪除請保持空陣列。"
            },
            "explanation": {
                "type": "string",
                "description": "簡短說明排班邏輯和考量"
            }
        },
        "required": ["scheduleData", "explanation"]
    }
}


@functions_framework.http
def generate_agent_schedule(request):
    """HTTP Cloud Function 入口"""
    origin = request.headers.get('Origin', '')

    # 處理 CORS preflight
    if request.method == 'OPTIONS':
        response = cors_response('', 204)
        return add_cors_headers(response, origin)

    # 檢查來源
    if origin and origin not in ALLOWED_ORIGINS:
        response = cors_response({'error': 'Forbidden origin'}, 403)
        return add_cors_headers(response, origin)

    # 只接受 POST
    if request.method != 'POST':
        response = cors_response({'error': 'Method not allowed'}, 405)
        return add_cors_headers(response, origin)

    try:
        data = request.get_json(force=True)
    except Exception:
        response = cors_response({'error': 'Invalid JSON'}, 400)
        return add_cors_headers(response, origin)

    # 取得參數
    prompt = data.get('prompt', '')
    current_schedule = data.get('currentSchedule', '{}')
    selected_model = data.get('selectedModel', 'claude-sonnet-4-6')
    active_rules = data.get('activeRules', {})
    attached_csv_text = data.get('attachedCsvText', '')
    chat_history = data.get('chatHistory', [])

    if not prompt:
        response = cors_response({'error': 'Missing prompt'}, 400)
        return add_cors_headers(response, origin)

    # 取得 API Key
    if not ANTHROPIC_API_KEY:
        response = cors_response({'error': 'API key not configured'}, 500)
        return add_cors_headers(response, origin)

    # 建立 System Prompt
    system_prompt = build_system_prompt(current_schedule, active_rules, attached_csv_text)

    # 組合對話紀錄
    messages = []
    for msg in chat_history:
        # 只允許 user 和 assistant 角色
        role = msg.get("role", "user")
        if role not in ["user", "assistant"]:
            role = "user"
        messages.append({
            "role": role,
            "content": msg.get("content", "")
        })
    # 加入當前 prompt
    messages.append({"role": "user", "content": prompt})

    try:
        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

        # 呼叫 Claude API
        message = client.messages.create(
            model=selected_model,
            max_tokens=8192,
            system=system_prompt,
            tools=[SCHEDULE_TOOL],
            tool_choice={"type": "auto"},
            messages=messages
        )

        # 從 tool_use 回應中取出結果
        result = None
        explanation = ''
        tool_input = None
        for content_block in message.content:   
            if content_block.type == 'tool_use' and content_block.name == 'update_schedule':
                tool_input = content_block.input or {}
                result = tool_input.get('scheduleData', [])
                explanation = tool_input.get('explanation', '')
                break

        # 如果沒有呼叫工具（代表 Claude 只是進行一般文字對話回答問題）
        if result is None:
            text_response = ''
            for content_block in message.content:
                if content_block.type == 'text':
                    text_response += content_block.text + '\n'
            
            # 將原封不動的 current_schedule 還給前端，這樣前端比對就不會有異動
            import json
            try:
                current_dict = json.loads(current_schedule)
                result = current_dict.get('scheduleData', [])
            except Exception:
                result = []
            
            explanation = text_response.strip()

        if not result:
            response = cors_response({'error': 'No schedule data in response'}, 500)
            return add_cors_headers(response, origin)

        response = cors_response({
            'scheduleData': result,
            'explanation': explanation,
            'addWeeks': tool_input.get('addWeeks', 0) if tool_input else 0,
            'removeWeeks': tool_input.get('removeWeeks', 0) if tool_input else 0,
            'addServiceColumns': tool_input.get('addServiceColumns', []) if tool_input else [],
            'removeServiceColumns': tool_input.get('removeServiceColumns', []) if tool_input else [],
            'model': selected_model,
            'usage': {
                'input_tokens': message.usage.input_tokens,
                'output_tokens': message.usage.output_tokens
            }
        })
        return add_cors_headers(response, origin)

    except anthropic.APIError as e:
        response = cors_response({'error': f'Claude API error: {str(e)}'}, 502)
        return add_cors_headers(response, origin)
    except Exception as e:
        response = cors_response({'error': f'Internal error: {str(e)}'}, 500)
        return add_cors_headers(response, origin)


def build_system_prompt(current_schedule, active_rules, attached_csv_text):
    """建立給 Claude 的 System Prompt"""
    rules_text = ''
    if active_rules.get('consecutive'):
        rules_text += '\n- 禁止同一人連續兩週（相鄰日期）擔任相同服事項目'
    if active_rules.get('maxRoles'):
        rules_text += '\n- 單一使用者在同一週內最多擔任 3 項服事'

    csv_section = ''
    if attached_csv_text:
        csv_section = f"""

## 使用者提供的參考資料 (CSV)
以下是使用者上傳的 CSV 資料，請參考此資料來排班：
<csv_data>
{attached_csv_text}
</csv_data>
"""

    rules_section = rules_text if rules_text else '\n- (無特定規則限制)'

    return f"""你是一個教會排班助手 AI。你的工作是根據使用者的指示，修改或產生排班表資料。

## 當前排班表（JSON 格式）
```json
{current_schedule}
```

## 排班規則
以下是必須遵守的排班規則：{rules_section}
{csv_section}
## 重要提示
1. 如需修改排班表，請必須使用 `update_schedule` 工具回傳完整的排班資料。如果使用者只是在聊天確認資訊，請不要呼叫工具，直接用文字回覆。
2. 若要求「新增週數」，請在 `addWeeks` 填入數量，且**必須在 `scheduleData` 陣列中直接加入對應的新週數物件**（日期自動加 7 天），如果你有安排人員請一併寫入新週數中。
3. 若要求「刪除週數」，請在 `removeWeeks` 填入數量，並將 `scheduleData` 中最後的週數物件移除。
4. 若要求「新增/刪除服事欄位」，請將名稱放入 `addServiceColumns` / `removeServiceColumns` 陣列中，並同步更新 `scheduleData` 每週物件中的鍵值。
5. 若要求「新增/編輯/刪除服事項目」，回傳的 `scheduleData` 中的每個物件必須包含 `date` 欄位和各服事項目欄位。
6. 服事項目的值必須是人名字串陣列（例如 ["小明", "小華"]）。
7. 請仔細遵守排班規則，不要讓任何人違反規則。
8. 如果使用者只要求修改部分內容，請保持其他部分不變。在 `explanation` 中簡短說明你的排班邏輯。"""
