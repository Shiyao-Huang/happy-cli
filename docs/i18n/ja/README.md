# Happy CLI

モデル管理、トークン監視、リアルタイムセッション制御など強力な機能を備えた Claude
Code のモバイルおよび Web クライアント。

無料。オープンソース。どこからでもコードを書ける。

## インストール

```bash
npm install -g happy-coder
```

## クイックスタート

```bash
happy
```

これにより：

1. モバイル制御が有効になった Claude Code セッションが開始されます
2. モバイルデバイスから接続するための QR コードが表示されます
3. Claude Code とモバイルアプリ間のリアルタイムセッション共有が可能になります
4. モデル切り替えやトークン監視などの高度な機能が有効になります

## 主なコマンド

### セッション制御

- `happy` - モバイル制御付き新しい Claude セッションを開始
- `happy --resume` - 以前のセッションを再開
- `happy --yolo` - 権限バイパスでセッションを開始（自動化用）
- `happy --to <model>` - 特定のモデルに切り替え（例：claude-3-5-haiku）
- `happy --yolo --to <model>` - モデルに切り替えてセッションを開始（例：GLM）

### モデル管理

- `happy --seeall` - 利用可能な全モデルを表示
- `happy --toadd <name>` - 新しいモデルプロファイルを追加
- `happy --del <name>` - モデルプロファイルを削除
- `happy --upd <name>` - モデルプロファイルを更新
- `happy --auto <pattern>` - 自動モデル切り替え（expensive|cheap|balanced）
- `happy --exp <file>` - モデル設定をエクスポート
- `happy --imp <file>` - モデル設定をインポート

### トークン監視

- `happy --stats` - 日次トークン使用量を表示
- `happy --watch` - リアルタイムトークン監視
- `happy --f compact` - コンパクト出力形式
- `happy --f table` - テーブル出力形式
- `happy --f json` - JSON 出力形式
- `happy daily` - 日次で統計をグループ化
- `happy weekly` - 週次で統計をグループ化
- `happy monthly` - 月次で統計をグループ化
- `happy --since 20240101` - 日付でフィルター（開始）
- `happy --until 20241231` - 日付でフィルター（終了）

### ダッシュボード

- `happy --dashboard` - リアルタイム監視ダッシュボードを開く

### ユーティリティコマンド

- `happy auth` – 認証とマシン設定を管理
- `happy auth login` – サービスに認証
- `happy auth logout` – 認証情報を削除
- `happy connect` – AI ベンダー API キーを Happy クラウドに接続
- `happy notify -p "message"` – デバイスにプッシュ通知を送信
- `happy codex` – Codex モードを開始（MCP ブリッジ）
- `happy daemon` – バックグラウンドサービスを管理
- `happy doctor` – システム診断とトラブルシューティング
- `happy doctor clean` – 暴走プロセスをクリーンアップ

### デーモン管理

- `happy daemon start` – バックグラウンドデーモンを開始
- `happy daemon stop` – デーモンを停止（セッションは存続）
- `happy daemon status` – デーモン状態を表示
- `happy daemon list` – アクティブセッションを一覧表示
- `happy daemon stop-session <id>` – 特定のセッションを停止
- `happy daemon logs` – デーモンログファイルパスを表示
- `happy daemon install` – デーモンサービスをインストール
- `happy daemon uninstall` – デーモンサービスをアンインストール

## オプション

### 一般的なオプション

- `-h, --help` - ヘルプを表示
- `-v, --version` - バージョンを表示
- `--started-by <mode>` - 起動元（daemon|terminal）
- `--happy-starting-mode <mode>` - 起動モード（local|remote）

### モデルと権限オプション

- `-m, --model <model>` - 使用する Claude モデル（デフォルト：sonnet）
- `-p, --permission-mode <mode>` - 権限モード：auto、default、plan
- `--yolo` - 全ての権限をバイパス（危険）
- `--dangerously-skip-permissions` - 権限チェックをスキップ（--yolo と同じ）

### Claude 統合

- `--claude-env KEY=VALUE` - Claude Code の環境変数を設定
- `--claude-arg ARG` - Claude CLI に追加引数を渡す
- `--resume` - 以前のセッションを再開
- **Happy はすべての Claude オプションをサポート！** -
  claude で使用するすべてのフラグを happy でも使用できます

## 環境変数

### サーバー設定

- `HAPPY_SERVER_URL` - カスタムサーバー URL（デフォルト：https://api.happy-servers.com）
- `HAPPY_WEBAPP_URL` - カスタム Web アプリ URL（デフォルト：https://app.happy.engineering）
- `HAPPY_HOME_DIR` -
  Happy データのカスタムホームディレクトリ（デフォルト：~/.happy）

### システム

- `HAPPY_DISABLE_CAFFEINATE` -
  macOS のサスペンダー防止を無効化（`true`、`1`、または `yes` に設定）
- `HAPPY_EXPERIMENTAL` - 実験的機能を有効化（`true`、`1`、または `yes` に設定）

### Claude 統合

- `ANTHROPIC_DEFAULT_SONNET_MODEL` - デフォルト Sonnet モデルを上書き
- `ANTHROPIC_MODEL` - デフォルト Claude モデルを設定
- `ANTHROPIC_BASE_URL` - カスタム Anthropic API ベース URL
- `ANTHROPIC_AUTH_TOKEN` - Anthropic API 認証トークン

## 使用例

### セッションの開始

```bash
happy                          # 新しいセッションを開始
happy --resume                 # 以前のセッションを再開
happy --yolo                   # 権限バイパスで開始
```

### モデル管理

```bash
happy --to claude-3-5-haiku    # Haiku モデルに切り替え
happy --yolo --to GLM          # GLM に切り替えて開始
happy --seeall                 # 利用可能な全モデルを表示
happy --toadd my-model         # カスタムモデルを追加
```

### トークン監視

```bash
happy --stats                  # 日次トークン使用量を表示
happy --watch                  # リアルタイム監視
happy --stats -f compact       # コンパクト形式
happy --stats weekly           # 週次でグループ化
happy --stats --since 20240101 --until 20241231  # 日付範囲
```

### 上級者向け

```bash
happy --dashboard              # リアルタイムダッシュボードを開く
happy auth login --force       # 再認証
happy notify -p "Test"         # 通知を送信
happy daemon status            # デーモン状態を確認
happy doctor                   # 診断を実行
```

## 必要要件

- **Node.js >= 20.0.0**
  - `eventsource-parser@3.0.5` に必要
  - `@modelcontextprotocol/sdk` に必要（権限転送に使用）
- **Claude CLI がインストールされログイン済み**（PATH で `claude`
  コマンドが利用可能）

## アーキテクチャ

Happy CLI は 3 コンポーネントシステム的一部分です：

1. **Happy CLI**（このプロジェクト）- Claude
   Code をラップするコマンドラインインターフェース
2. **Happy** - React Native モバイルクライアント
3. **Happy Server** -
   Prisma を使用した Node.js サーバー（https://api.happy-servers.com/
   でホスティング）

### 主な機能

- **デュアルモード操作**：インタラクティブ（ターミナル）とリモート（モバイル制御）
- **エンドツーエンド暗号化**：全通信が TweetNaCl で暗号化
- **セッション永続化**：再起動 Across でセッションを再開
- **モデル管理**：プロファイルを使用して異なる Claude モデル間を切り替え
- **トークン監視**：リアルタイム追跡と履歴統計
- **デーモンアーキテクチャ**：バックグラウンドサービスがセッションを管理
- **権限転送**：モバイルアプリが Claude 権限を承認/拒否

## ライセンス

MIT
