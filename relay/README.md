# Somnia face relay

Somnia の公開顔状態を受け取り、Webサイトと将来のアプリへ配信する Cloudflare Worker。
最新状態は SQLite-backed Durable Object に1件だけ保持し、履歴・会話・思考内容は保存しない。

## API

- `POST /v1/publish` — Somnia publisher 専用。`Authorization: Bearer` 必須。
- `GET /v1/state` — 公開中の最新状態。30秒で `live: false`。
- `GET /v1/stream` — 公開読み取り専用 WebSocket。
- `GET /health` — リレー自体のヘルスチェック。

`POST` は `somnia.face-state.v1` を厳格検証し、公開8種へ畳み込み済みの
`primary / energy / mood / effects` だけを受け付ける。`session_id + sequence` で重複を、
`observed_at` でセッションをまたぐ逆順を拒否する。
`effects` は `sparkle / surprise / beacon / ack` の表現意図だけを公開し、
ウインクやリングなどの具体的な描画方法はクライアント側で決める。

公開先: `https://somnia-face-relay.somnia-ai.workers.dev`

## ローカル開発

```powershell
cd relay
npm install
Copy-Item .dev.vars.example .dev.vars
npm test
npm run dev
```

`.dev.vars` はGit管理外。実トークンをソースや `wrangler.jsonc` に書かないこと。

## Cloudflareへの初回デプロイ

WindowsホストからWorkerのデプロイとSomnia側のサービス起動をまとめて行える。
スクリプトは公開用トークンを生成し、一時ファイル経由でCloudflareへ登録したあと削除する。
WSL側の資格情報ファイルはモード `600` で作成する。
初回は未登録の場合に限り `somnia-ai.workers.dev` をアカウントのサブドメインとして登録する。

```powershell
cd relay
npx wrangler login
npm run check
npm test
.\scripts\deploy-and-enable.ps1
```

リレーだけをデプロイする場合は、`PUBLISH_TOKEN` を含む一時 `.env` を作り、
`npx wrangler deploy --secrets-file <path>` に渡す。そのファイルはGitへ追加しないこと。
