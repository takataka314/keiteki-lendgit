# Node 20 のイメージを使う
FROM node:20

# アプリを置くディレクトリ
WORKDIR /app

# package.json をコピー
COPY package*.json ./

# 依存をインストール
RUN npm install

# アプリソース全部コピー
COPY . .

# Cloud Run は $PORT の環境変数を使うので server.js 側で利用する
ENV PORT=8080

# ポート公開
EXPOSE 8080

# サーバーを起動
CMD ["node", "server.js"]
