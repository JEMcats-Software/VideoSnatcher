const { app, BrowserWindow, session, screen } = require('electron');
const { exec } = require('child_process');
const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https'); // Add this import
const { v4: uuidv4 } = require('uuid');


const expressApp = express();
let serverPort, ytWin;
let youtubeCookies = "";

const baseDir = path.join(os.homedir(), 'Library/Application Support/videosnatcher');
const logsDir = path.join(baseDir, 'logs');
const liveLogPath = path.join(logsDir, 'live.log');
const userDataDir = path.join(baseDir, 'UserData');
const executablesDir = path.join(baseDir, 'AppExecutables');

// Ensure logs directory exists and clear log file on startup
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
fs.writeFileSync(liveLogPath, '', 'utf8');

// Override console.log and console.error to also write to a log file
const logStream = fs.createWriteStream(liveLogPath, { flags: 'a' });
['log', 'error'].forEach(method => {
    const original = console[method];
    console[method] = (...args) => {
        original(...args);
        logStream.write(args.join(' ') + '\n');
    };
});

function convertCookiesToNetscapeFormat(cookies) {
    return [
        "# Netscape HTTP Cookie File", // Required header
        ...cookies.map(cookie => {
            let domain = cookie.domain || "";
            if (!domain.startsWith(".")) {
                domain = "." + domain; // Ensure proper domain format
            }
            return [
                domain,
                "TRUE", // Include subdomains (assumed safe for most use cases)
                cookie.path || "/", // Default to root path if missing
                cookie.secure ? "TRUE" : "FALSE", // Secure flag
                Math.floor(cookie.expirationDate || 0), // Ensure it's a valid timestamp
                cookie.name,
                cookie.value
            ].join("\t");
        })
    ].join("\n");
}

function ensureFile(filePath, url) {
    if (!fs.existsSync(filePath)) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        if (url) {
            const file = fs.createWriteStream(filePath);
            https.get(url, (response) => {
                if (response.statusCode === 200) {
                    response.pipe(file);
                    file.on('finish', () => {
                        file.close();
                        fs.chmodSync(filePath, '755'); // Make the file executable
                        console.log(`${path.basename(filePath)} downloaded and made executable.`);
                    });
                } else {
                    console.error(`Failed to download ${url}. Status code: ${response.statusCode}`);
                }
            }).on('error', (err) => {
                console.error(`Error downloading ${url}:`, err.message);
            });
        } else {
            fs.writeFileSync(filePath, '', 'utf8');
            console.log(`${path.basename(filePath)} created successfully.`);
        }
    } else {
        console.log(`${path.basename(filePath)} already exists.`);
    }
}

function parseVideoFormats(output) {
    const filtered = output.split('\n').filter(line => {
        line = line.trim();
        if (!line) return false;
        if (/(Downloading|Available formats|ID|-------------------)/.test(line)) return false;
        const matches = line.match(/\[[^\]]*\]/g);
        if (matches) {
            for (const m of matches) {
                const content = m.slice(1, -1);
                // Allow only if content has exactly two letters.
                if (!/^[A-Za-z]{2}$/.test(content)) return false;
            }
        }
        return true;
    });

    const result = filtered.map(line => {
        if (line.toLowerCase().includes('quic')) return null; // Skip lines containing 'quic'
        let parts = line.split(/\s{2,}/).map(x => x.trim()).flatMap(part =>
            part.split('|').map(x => x.trim()).filter(Boolean)
        );
        const firstSplit = parts[0].split(' ').map(x => x.trim());
        parts[0] = firstSplit[0];
        parts.splice(1, 0, firstSplit[1] || '', firstSplit.slice(2).join(' ') || '');
        parts = parts.flatMap(part => part.split(' ').map(x => x.trim())).filter(x => x && x !== 'unknown' && x !== 'Original');
        for (let i = 0; i < parts.length - 1; i++) {
            if ((parts[i] === 'video' && parts[i + 1] === 'only') ||
                    (parts[i] === 'audio' && parts[i + 1] === 'only')) {
                parts[i] = `${parts[i]} only`;
                parts.splice(i + 1, 1);
                break;
            }
        }
        return parts;
    }).filter(parts => parts && parts.length > 1 && !parts.includes('images'));

    // Remove duplicate entries
    const unique = Array.from(new Set(result.map(a => JSON.stringify(a)))).map(e => JSON.parse(e));
    return unique.map(item => Array.from(new Set(item)));
}

function createMainWindow() {
    const win = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: { nodeIntegration: true }
    });
    win.loadURL(`file://${__dirname}/web/index.html?port=${serverPort}`);
    win.on('closed', () => app.quit());
}

function createYoutubePopup() {
    const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
    const winWidth = Math.min(600, Math.floor(screenWidth * 0.7));
    const infoHeight = Math.min(200, Math.floor(screenHeight * 0.2));
    const ytHeight = Math.min(400, Math.floor(screenHeight * 0.3));
    const startX = Math.floor((screenWidth - winWidth) / 2);
    const infoY = Math.floor((screenHeight - (infoHeight + ytHeight)) / 2);
    const ytY = infoY + infoHeight;

    const infoWin = new BrowserWindow({
        x: startX,
        y: infoY,
        width: winWidth,
        height: infoHeight,
        resizable: false,
        webPreferences: { nodeIntegration: true }
    });

    ytWin = new BrowserWindow({
        x: startX,
        y: ytY,
        width: winWidth,
        height: ytHeight,
        resizable: false,
        webPreferences: { nodeIntegration: true }
    });
    ytWin.loadURL('https://youtube.com');
    ytWin.on('closed', () => {
        if (!infoWin.isDestroyed()) infoWin.close();
        youtubeCookies = "";
    });

    infoWin.loadURL(`file://${__dirname}/web/yt_cookie_retriver.html?port=${serverPort}`);
    infoWin.on('closed', () => {
        if (!ytWin.isDestroyed()) ytWin.close();
        youtubeCookies = "";
    });
}

function createListWindow() {
    const win = new BrowserWindow({
        width: 450,
        height: 600,
        webPreferences: { nodeIntegration: true }
    });
    win.loadURL(`file://${__dirname}/web/supported.html`);
}

// Start express server on a random port
const server = expressApp.listen(0, () => {
    serverPort = server.address().port;
    console.log(`Server running on port ${serverPort}`);
});

expressApp.get('/get_vid_options', (req, res) => {
    const videoUrl = req.query.url;
    const vimeoPass = req.query.vimeoPass;

    if (!videoUrl) return res.status(400).send('Missing "url" parameter');

    let parameters = videoUrl.includes("youtube.com")
        ? ` --cookies "${path.join(userDataDir, 'yt-cookie.txt')}"`
        : '';
    parameters = vimeoPass
        ? ` --video-password "${vimeoPass}"`
        : '';
    const command = `"${path.join(executablesDir, 'yt-dlp-mac')}"${parameters} -F "${videoUrl}"`;

    exec(command, { encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) {
            console.error(error);
            return res.status(500).send('Error fetching video options');
        }
        try {
            const parsed = parseVideoFormats(stdout);
            res.send(parsed);
        } catch (e) {
            console.error(e);
            res.status(500).send('Error parsing video options');
        }
    });
});

expressApp.get('/download_vid', (req, res) => {
    const videoUrl = req.query.url;
    const vimeoPass = req.query.vimeoPass;
    const videoFormat = req.query.id;
    const videoType = req.query.type;

    if (!videoUrl) return res.status(400).send('Missing "url" parameter');
    if (!videoFormat) return res.status(400).send('Missing "format" parameter');

    let parameters = videoUrl.includes("youtube.com")
        ? ` --cookies "${path.join(userDataDir, 'yt-cookie.txt')}"`
        : '';
    parameters = vimeoPass && vimeoPass !== undefined
        ? ` --video-password "${vimeoPass}"`
        : '';

    if (videoFormat.includes('vid') && videoFormat.includes('aud')) {
        const video_download_id = uuidv4();
        const audio_download_id = uuidv4();
        const [videoId, audioId] = videoFormat
            .split(',')
            .map(part => part.split(':')[1].trim());
        
    } else {
        const video_download_id = uuidv4();
        
        const command = `"${path.join(executablesDir, 'yt-dlp-mac')}"${parameters} -f "${videoFormat}" "${videoUrl}" -o "${path.join(baseDir, 'OutputFiles')}/${video_download_id}.${videoType}"`;
        exec(command, { encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout) => {
            if (error) {
                console.error(error);
                return res.status(500).send('Error downloading video');
            }
            try {
                const download_path = `${path.join(baseDir, 'OutputFiles')}/${video_download_id}.${videoType}`
                res.send(JSON.stringify({ download_path }));
            } catch (e) {
                console.error(e);
                res.status(500).send('Error downloading video');
            }
        });
    }
});

expressApp.get('/show_supported_list', (req, res) => {
    createListWindow();
    res.send('Success');
});

expressApp.get('/run_youtube_signin', (req, res) => {
    createYoutubePopup();
    res.send('Success');
});

expressApp.get('/get_youtube_cookies', async (req, res) => {
    try {
        const cookies = await session.defaultSession.cookies.get({ url: 'https://youtube.com' });
        youtubeCookies = convertCookiesToNetscapeFormat(cookies);
        res.send("Success");
    } catch (error) {
        console.error("Error getting YouTube cookies:", error);
        res.status(500).send('Error getting YouTube cookies');
    }
});

expressApp.get('/finish_youtube_cookies', (req, res) => {
    fs.writeFileSync(path.join(userDataDir, 'yt-cookie.txt'), youtubeCookies);
    res.send("Success");
    if (ytWin && !ytWin.isDestroyed()) ytWin.close();
});

app.whenReady().then(() => {
    ensureFile(path.join(userDataDir, 'yt-cookie.txt'));
    ensureFile(
        path.join(executablesDir, 'yt-dlp-mac'),
        'https://jemcats.software/github_pages/VideoSnatcher/files/yt-dlp-mac'
    );
    ensureFile(
        path.join(executablesDir, 'ffmpeg-mac'),
        'https://jemcats.software/github_pages/VideoSnatcher/files/ffmpeg-mac'
    );
    createMainWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
