import https from "https";

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function run() {
  const playlistId = "PLofHT4Sd3FQDPL72Qy2Q5zBfL42qB5N16";
  const instances = [
    "https://yewtu.be",
    "https://invidious.projectsegfau.lt",
    "https://invidious.nerdvpn.de"
  ];
  
  for (const instance of instances) {
    const url = `${instance}/api/v1/playlists/${playlistId}`;
    console.log("Trying Invidious instance:", url);
    try {
      const data = await fetchJson(url);
      console.log("Success! Playlist Title:", data.title);
      console.log("Videos found:", data.videos?.length);
      if (data.videos && data.videos.length > 0) {
        console.log("First Video:", data.videos[0].title, "ID:", data.videos[0].videoId);
      }
      return;
    } catch (err) {
      console.log("Instance failed:", instance, "Error:", err.message);
    }
  }
}

run();
