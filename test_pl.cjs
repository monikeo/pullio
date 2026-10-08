const cp = require('child_process');
cp.exec('node_modules\\\\youtube-dl-exec\\\\bin\\\\yt-dlp.exe --dump-single-json --flat-playlist --yes-playlist --no-warnings --no-check-certificates --prefer-insecure --geo-bypass --user-agent "Mozilla/5.0" "https://www.youtube.com/playlist?list=PLrKoKg764KkK2rS3j6V9l1_vWqG5J0v5S"', {maxBuffer: 25*1024*1024}, (err, stdout, stderr) => {
  if (err) {
    console.error(err);
  }
  console.log("STDOUT LENGTH:", stdout.length);
  if (stdout) {
    console.log(stdout.slice(0, 1000));
    try {
      const data = JSON.parse(stdout);
      console.log("JSON parsed successfully");
      console.log("Type:", data._type);
      console.log("Title:", data.title);
      console.log("Entries count:", data.entries ? data.entries.length : 0);
    } catch(e) {
      console.log("Error parsing JSON", e);
    }
  }
  console.error("STDERR:", stderr);
});
