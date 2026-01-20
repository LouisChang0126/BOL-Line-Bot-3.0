這是一份舊的程式碼，架設在Google Cloud Function上，串聯LINE Bot與firebase，提供服事系統的調班、代班、提醒等功能
現在要改成適合schedule-app/中設計的collection 結構

要修改登入方式，從原本的輸入名字登入，改成用邀請碼(login_token)登入，參考schedule-app/

現在的users collection 結構如下，參考schedule-app/：
{
  alarm_type: [false, false, false, false, false, false], // 週一至週六提醒
  lineId: "",                                              // LINE 使用者 ID
  serve_types: {
    "youth-serve": ["主領", "音控"],                        // 各場崇拜的服事項目
    "kids-serve": ["司會"]
  }
}

原本的程式碼只支援單一一場崇拜(service collection)，要改成支援多場崇拜，多個collection，參考users collection的serve_types取得用戶在哪場崇拜

在換班與代班時，shift_0的mode_text要加入顯示崇拜的名稱

每場崇拜的服事種類不同，def weekText()要改成抓取_metadata的serviceItems順序來顯示，而不是固定寫死，參考schedule-app/

整理程式碼(可以改function名稱)，讓程式碼更加簡潔易懂，並加上適當的註解