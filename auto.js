const fetch = require('node-fetch'); // pastikan sudah install: npm i node-fetch

const query = process.argv[2];
const maxPages = parseInt(process.argv[3]) || 1;

if (!query) {
  console.error('❌ Query wajib diisi. Contoh: node auto-fetch.js "isekai" 2');
  process.exit(1);
}

(async () => {
  const allComics = [];

  // Step 1: Pencarian multi-halaman
  for (let page = 1; page <= maxPages; page++) {
    try {
      const url = `http://159.65.138.143:5000/search?q=${encodeURIComponent(query)}&page=${page}`;
      const response = await fetch(url);
      const data = await response.json();

      if (!data.results?.length) break;
      allComics.push(...data.results);
    } catch (err) {
      console.error(`❌ Gagal fetch search page ${page}: ${err.message}`);
      process.exit(1);
    }
  }

  const finalOutput = [];

  // Step 2: Fetch detail dan semua chapter
  for (const comic of allComics) {
    const slug = comic.link.split('/').filter(Boolean).pop();

    try {
      const detailUrl = `http://159.65.138.143:5000/detail?url=${slug}`;
      const detailRes = await fetch(detailUrl);
      const detailData = await detailRes.json();

      if (!detailData.success) {
        finalOutput.push({ title: comic.title, status: 'detail_failed' });
        continue;
      }

      const chapters = detailData.detail?.chapters || [];
      const chapterResults = [];

      for (const chapter of chapters) {
        const chapSlug = chapter.chapterLink.replace(/^\/|\/$/g, '');

        try {
          const fetchUrl = `http://159.65.138.143:5000/get-comic?url=${chapSlug}`;
          const fetchRes = await fetch(fetchUrl).then(res => res.json());

          chapterResults.push({
            chapter: chapter.chapterTitle,
            status: fetchRes.success ? 'ok' : 'failed',
            reason: fetchRes.error || null
          });

        } catch (err) {
          chapterResults.push({
            chapter: chapter.chapterTitle,
            status: 'fetch_error',
            reason: err.message
          });
        }
      }

      finalOutput.push({
        title: detailData.detail.title,
        chaptersFetched: chapterResults.length,
        chapters: chapterResults
      });

    } catch (err) {
      finalOutput.push({ title: comic.title, status: 'error', reason: err.message });
    }
  }

  console.log(JSON.stringify({
    success: true,
    total: finalOutput.length,
    results: finalOutput
  }, null, 2));
})();
