const cp = require('child_process');

function testUrl(url) {
  console.log("Testing:", url);
  cp.exec(`node_modules\\\\youtube-dl-exec\\\\bin\\\\yt-dlp.exe --dump-json --no-playlist --no-warnings --no-check-certificates --prefer-insecure --geo-bypass --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" "${url}"`, {maxBuffer: 25*1024*1024}, (err, stdout, stderr) => {
    if (err) {
      console.error("Error for", url, ":", stderr.slice(0, 500));
    } else {
      try {
        const data = JSON.parse(stdout);
        console.log("Success for", url, "Title:", data.title);
      } catch(e) {
        console.error("Parse error for", url);
      }
    }
  });
}

testUrl("https://www.facebook.com/watch/?v=123456789");
testUrl("https://www.bilibili.com/video/BV1xx411c7mD/");
testUrl("https://www.youtube.com/playlist?list=PL4lCaoQKL_QQsE44m-b850gI2c4hF5_vA");
