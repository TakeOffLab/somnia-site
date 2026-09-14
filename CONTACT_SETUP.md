# お問い合わせフォームの接続

フォームの画面は `contact.html`、専用スタイルは `contact.css`、入力確認と二重送信防止は `contact-form.js` にあります。
受信先メールアドレスはHTMLやJavaScriptに保存せず、Formspreeの管理画面で設定します。

## 現在の状態

ユーザーが作成したフォーム `https://formspree.io/f/xgaegpjd` を接続しています。
APIキーや受信先アドレスをサイトへ埋め込む必要はありません。
2026-09-15に接続テストを1件送信し、Formspreeの日本語の受付完了画面まで確認しました。通知メールの実受信は受信先のメールボックスで確認してください。

## 接続手順

1. [Formspree](https://formspree.io/)でアカウントを作成し、受信先のメールアドレスを確認します。
2. 「New Form」でSomnia用フォームを作成します。Target Emailには現在の問い合わせ先を設定し、メール通知を有効にします。
3. Integrationにある `https://formspree.io/f/…` を `contact.html` の `id="contact-form"` にある `action` に設定します。フォームURLは公開用の識別子です。APIキーは不要です。
4. ローカルのページで必須入力・メール形式・受付完了を確認してから公開します。通知メールが届くことと、本文・返信先が正しいことも受信先のメールボックスで確認してください。

## 送信の流れ

ブラウザーの標準POSTでFormspreeへ送ります。必要に応じてFormspreeの迷惑投稿確認が表示され、受付後は日本語の完了画面へ進みます。ブラウザーが戻った際には送信ボタンを復帰させます。

- `email` を返信先として使用します。
- `_subject` は「Somniaサイトからのお問い合わせ」。
- `_language=ja` で確認・完了画面を日本語にします。
- `_gotcha` は迷惑投稿を判定するための非表示欄です。
- 添付ファイル、自動返信、送信内容のブラウザー保存は追加していません。
- Formspreeは問い合わせを受け付け、アカウント内にも保存します。保存先・通知先・迷惑投稿設定はFormspree側で管理します。
- JavaScriptが使えない場合も標準のHTMLフォームとして送信できます。JavaScript使用時は接続先URLの形式を検証し、不正な場合にフォームを無効にします。

公式資料: [HTMLフォーム](https://help.formspree.io/articles/building-your-form/building-an-html-form)、[日本語表示](https://help.formspree.io/articles/building-your-form/localization-and-translation)、[迷惑投稿対策](https://help.formspree.io/articles/building-your-form/honeypot-spam-filtering)。
