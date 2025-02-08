const { app, BrowserWindow, session, screen } = require('electron');
const { execSync } = require('child_process');
const express = require('express');
const expressapp = express();
const fs = require('fs');
const path = require('path');
const os = require('os');

let youtube_cookies = "";

function convertCookiesToNetscapeFormat(cookies) {
    let formattedCookies = [];
    
    cookies.forEach(cookie => {
    // Construct the Netscape HTTP Cookie File format line for each cookie
    let cookieLine = [
    cookie.domain || '',
    'TRUE', // Flag indicating if it's a domain cookie (TRUE for host-only)
    cookie.path,
    String(cookie.secure), // Secure flag (TRUE or FALSE)
    String(cookie.expirationDate), // Expiration time in seconds since epoch
    cookie.name,
    cookie.value
    ].join('\t');
    
    formattedCookies.push(cookieLine);
    });
    
    return formattedCookies.join('\n');
}

function ensureCookieFile() {
    // Resolve the full path
    const userDataDir = path.join(os.homedir(), 'Library/Application Support/videosnatcher/UserData');
    const cookieFilePath = path.join(userDataDir, 'yt-cookie.txt');

    try {
        if (!fs.existsSync(cookieFilePath)) {
            // Ensure the directory exists
            fs.mkdirSync(userDataDir, { recursive: true });

            // Create the file
            fs.writeFileSync(cookieFilePath, '', 'utf8');
            console.log('yt-cookie.txt file created successfully.');
        } else {
            console.log('yt-cookie.txt already exists. No action needed.');
        }
    } catch (error) {
        console.error('Error ensuring yt-cookie.txt:', error);
    }
}

function parseVideoFormats(output) {
    const lines = output.split('\n').filter(line =>
        !line.includes('[') &&
        !line.includes(']') &&
        !line.includes('Downloading') &&
        !line.includes('Available formats') &&
        !line.includes('ID') &&
        !line.includes('-------------------') &&
        line.trim()
    );

    const result = lines.map(line => {
        let parts = line.split(/\s{2,}/).map(part => part.trim());
        parts = parts.flatMap(part => part.split('|').map(subPart =>
            subPart.trim()).filter(subPart => subPart));
        const firstPart = parts[0].split(' ').map(subPart => subPart.trim());
        parts[0] = firstPart[0];
        parts.splice(1, 0, firstPart[1] || '');
        parts.splice(2, 0, firstPart.slice(2).join(' ') || '');
        parts = parts.flatMap(part => part.split(' ').map(subPart =>
            subPart.trim()));
        parts = parts.filter(value => value && value !== 'unknown' && value
            !== 'Original');
        for (let i = 0; i < parts.length - 1; i++) {
            if (parts[i] === "video" && parts[i + 1] === "only") {
                parts[i] = "video only";
                parts.splice(i + 1, 1);
                break;
            }
            if (parts[i] === "audio" && parts[i + 1] === "only") {
                parts[i] = "audio only";
                parts.splice(i + 1, 1);
                break;
            }
        }
        if (parts.includes("audio only") && parts.indexOf("audio only") !==
            parts.lastIndexOf("audio only")) {
            parts = parts.filter((value, index) => value !== "audio only" ||
                index === parts.indexOf("audio only"));
        }
        return parts;
    })
        .filter(parts => parts.length > 1)  // Remove empty entries
        .filter(parts => !parts.includes("images")); // Remove entries containing "images"

    const uniqueResult = Array.from(new Set(result.map(a =>
        JSON.stringify(a))))
        .map(e => JSON.parse(e));

    const finalResult = uniqueResult.map(item => Array.from(new Set(item)));

    return finalResult;
}

function createWindow() {
    const win = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            nodeIntegration: true
        }
    });

    win.loadURL(`file://${__dirname}/web/index.html?port=${serverPort}`);
    win.on('closed', () => {
        app.quit();
    });

}

let yt_win;

function createYoutubePopup() {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

    // Adjust width and heights relative to screen size while capping to desired maximums.
    const winWidth = Math.min(600, Math.floor(screenWidth * 0.7)); 
    const infoHeight = Math.min(800, Math.floor(screenHeight * 0.2));
    const ytHeight = Math.min(400, Math.floor(screenHeight * 0.3));

    // Center horizontally and vertically (info_win on top, yt_win below)
    const startX = Math.floor((screenWidth - winWidth) / 2);
    const infoY = Math.floor((screenHeight - (infoHeight + ytHeight)) / 2);
    const ytY = infoY + infoHeight;

    const info_win = new BrowserWindow({
        x: startX,
        y: infoY,
        width: winWidth,
        height: infoHeight,
        // resizable: false,
        minimizable: false,
        maximizable: false,
        webPreferences: {
            nodeIntegration: true
        }
    });

    yt_win = new BrowserWindow({
        x: startX,
        y: ytY,
        width: winWidth,
        height: ytHeight,
        resizable: false,
        minimizable: false,
        maximizable: false,
        webPreferences: {
            nodeIntegration: true
        }
    });
    yt_win.loadURL(`https://youtube.com`);
    yt_win.on('closed', () => {
        if (info_win && !info_win.isDestroyed()) {
            info_win.close();
        }
        youtube_cookies = "";
    });
    info_win.loadURL(`file://${__dirname}/web/yt_cookie_retriver.html?port=${serverPort}`);
    info_win.on('closed', () => {
        if (yt_win && !yt_win.isDestroyed()) {
            yt_win.close();
        }
        youtube_cookies = "";
    });
}

function createListWindow() {
    const win = new BrowserWindow({
        width: 450,
        height: 600,
        webPreferences: {
            nodeIntegration: true
        }
    });

    win.loadURL(`file://${__dirname}/web/supported.html`);
}

let serverPort;
const server = expressapp.listen(0, () => {
    serverPort = server.address().port;
    console.log(`Server is running on port ${serverPort}`);
});

expressapp.get('/get_vid_options', (req, res) => {
    try {
        const videoUrl = req.query.url; // Get the 'url' parameter from the request

        if (!videoUrl) {
            return res.status(400).send('Missing "url" parameter');
        }

        if (videoUrl.includes("youtube.com")) {
            const output = execSync(`./yt-dlp-mac --cookies "~/Library/Application Support/videosnatcher/UserData/yt-cookie.txt" -F "${videoUrl}"`, { encoding: 'utf8' });
            const parsedOutput = parseVideoFormats(output);

            console.log(parsedOutput);
            res.send(parsedOutput);
        } else {
            const output = execSync(`./yt-dlp-mac -F "${videoUrl}"`, { encoding: 'utf8' });
            const parsedOutput = parseVideoFormats(output);

            console.log(parsedOutput);
            res.send(parsedOutput);
        }
    } catch (error) {
        console.error(error);
        res.status(500).send('Error fetching video options');
    }
});

expressapp.get('/show_supported_list', (req, res) => {
    createListWindow()
});

expressapp.get('/run_youtube_signin', (req, res) => {
    createYoutubePopup()
});

expressapp.get('/get_youtube_cookies', async (req, res) => {
    try {
        const cookies = await session.defaultSession.cookies.get({ url: 'https://youtube.com' });
        youtube_cookies = convertCookiesToNetscapeFormat(cookies);
        res.send("Success");
    } catch (error) {
        console.error("Error getting YouTube cookies:", error);
        res.status(500).send('Error getting YouTube cookies');
    }
});

expressapp.get('/finish_youtube_cookies', (req, res) => {
    fs.writeFileSync(path.join(os.homedir(), 'Library/Application Support/videosnatcher/UserData/yt-cookie.txt'), youtube_cookies);
    res.send("Success");
    yt_win.close();
});

app.whenReady().then(ensureCookieFile);
app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});