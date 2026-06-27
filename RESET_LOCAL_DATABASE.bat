@echo off
cd /d "%~dp0tld-monitoring-deployable"
echo This will delete the local test SQLite database only.
echo Uploaded files in data\uploads are not deleted.
pause
if exist data\radpro_tld.db del /f /q data\radpro_tld.db
if exist data\radpro_tld.db-wal del /f /q data\radpro_tld.db-wal
if exist data\radpro_tld.db-shm del /f /q data\radpro_tld.db-shm
echo Local database reset complete. Now run START_RADPRO_WINDOWS.bat
pause
