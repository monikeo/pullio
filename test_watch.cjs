const cp = require('child_process');
cp.exec('node_modules\\\\youtube-dl-exec\\\\bin\\\\yt-dlp.exe --dump-single-json --flat-playlist --yes-playlist --no-warnings "https://www.youtube.com/watch?v=aqz-KE-bpKQ&list=PLrEnWoR732-BHrPp_Pm8_VleD68f9s14-"', {maxBuffer: 25*1024*1024}, (err, stdout) => {
  if(err) {
      console.log('err', err.message);
  } else {
    try {
        const info = JSON.parse(stdout);
        console.log('_type:', info._type, 'entries count:', info.entries ? info.entries.length : 0);
    } catch(e) {}
  }
});
