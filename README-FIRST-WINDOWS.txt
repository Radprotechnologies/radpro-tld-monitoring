RADPRO TLD PERSONAL MONITORING SERVICE - WINDOWS START GUIDE

Do NOT open public\index.html directly.
This is a deployable Node.js + SQLite app. The browser page needs the backend server for login, database, file uploads, notifications, Radiation Safety Committee records, PDF exports and audit packs.

EASIEST START:
1. Extract this ZIP fully to a normal folder, for example F:\RadproTLD\
   Do not run it from WinRAR/Temp/Rar$EXa...
2. Double-click START-RADPRO-WINDOWS.bat
3. Wait while dependencies install on the first run.
4. Browser will open: http://localhost:3000
5. Login:
   Username: rso
   Password: rso123

MANUAL START FROM CMD:
cd /d F:\RadproTLD\radpro-tld-monitoring-notifications-rsc-edition\tld-monitoring-deployable
if not exist .env copy .env.example .env
npm install
npm start

Then open:
http://localhost:3000

Keep the command window open while using the app.
