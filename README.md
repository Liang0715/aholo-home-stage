# 拍一张，摆进家

用群核科技 Aholo Lux3D 把一张家居照片变成 3D 模型，在浏览器里对比原图、布置展台和预览 AR。

## 在线 Demo

[打开公开 Demo](https://liang0715.github.io/aholo-home-stage/)

## 作品功能

- **3D 展厅**可以按类别浏览展品，对照原图查看、旋转和缩放模型，也可以下载 GLB。在支持 AR 的设备上可以预览模型。
- **3D 展台**可以同时摆放最多 6 件展品，调整台面大小和物件的离地高度，例如把盆栽放到木桌上。展台会提示重叠和越界，复制分享链接即可在另一台设备上恢复布局。
- **本地上传生成**接收 JPG 或 PNG 照片，显示任务进度，并在完成后提供 GLB 预览和下载。这个功能需要在本机运行后端。

展台尺寸为模型单位，不代表真实尺寸。

## Lux3D 的使用

木椅使用 Lux3D 网页版生成。青绿色陶瓷杯、台灯、木桌和盆栽使用 Aholo API 生成。后端上传照片、创建图生 3D 任务并等待结果，再保存生成的 GLB。单次生成约需 6 分钟。

## Windows 本地运行

1. 安装 Node.js 22.13.0 或更高版本。下载仓库，在 PowerShell 中进入包含 `package.json` 的项目文件夹。
2. 安装依赖并打开本机配置。

   ```powershell
   npm.cmd ci
   if (-not (Test-Path -LiteralPath '.env')) {
     Copy-Item -LiteralPath '.env.example' -Destination '.env'
   }
   notepad .env
   ```

3. 在记事本中填写自己的 `AHOLO_API_KEY`，为 `ACCESS_CODE` 设置本机访问口令，然后按 `Ctrl+S` 保存。示例已配置网关 `https://api.aholo3d.cn` 和端口 `3000`。
4. 启动服务并保持 PowerShell 窗口打开。

   ```powershell
   npm.cmd start
   ```

5. 在浏览器打开展厅。点击「上传生成」，选一张不超过 5 MB 的 JPG 或 PNG，填写刚设置的访问口令，再点击「生成 3D 模型」。[打开本机展厅](http://127.0.0.1:3000/)
