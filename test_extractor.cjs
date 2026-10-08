const cp = require('child_process');
cp.exec('node_modules\\\\youtube-dl-exec\\\\bin\\\\yt-dlp.exe --dump-json --no-playlist --extractor-args "youtube:player-client=web,android;youtube:player_client=web,android" https://www.youtube.com/watch?v=aqz-KE-bpKQ', {maxBuffer: 25*1024*1024}, (err, stdout) => {
  const info = JSON.parse(stdout);
  const heights = info.formats.map(f => f.height).filter(h => h);
  console.log('Heights with bypass:', [...new Set(heights)]);
});
