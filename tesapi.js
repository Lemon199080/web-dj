const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cors = require('cors');
const NodeCache = require('node-cache');
const compression = require('compression');
const AbortController = require('abort-controller');
const axios = require('axios')
const fs = require('fs');
const { Readable } = require('stream');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// Import database and R2 upload functions
const { sql } = require('./config.js');
const { uploadToR2 } = require('./uploadToR2.js');

puppeteer.use(StealthPlugin());
const app = express();
const PORT = process.env.PORT || 5000;

// Increased cache duration for better performance
const cache = new NodeCache({ stdTTL: 1800 }); // Cache for 30 minutes

// Middleware
app.use(cors());
app.use(compression({
  level: 6, // Higher compression level
  threshold: 0 // Compress all responses
}));
app.use(express.json({ limit: '1mb' })); // Limit payload size

// Configuration with optimized browser settings
const CONFIG = {
  headless: false,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-infobars',
    '--js-flags=--max-old-space-size=500'
  ],
  defaultViewport: { width: 1280, height: 720 },
  ignoreHTTPSErrors: true,
  timeout: 15000
};

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://doujindesu.tv/',
  'Accept-Language': 'en-US,en;q=0.9'
};

// Constants
const urlBase = 'https://doujindesu.tv/';
const DEFAULT_TIMEOUT = 10000; // Default timeout for page operations

// Browser Pool
let browserPool = [];
const POOL_SIZE = 3; // Reduced pool size for lower memory usage
let isPoolInitialized = false;

// Improved timeout and abort handling
const createTimeout = (ms) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    try {
      controller.abort();
    } catch (e) {
      console.error('Error aborting request:', e);
    }
  }, ms);
  return { controller, timeout };
};

const initBrowserPool = async () => {
  if (isPoolInitialized) return;
  
  for (let i = 0; i < POOL_SIZE; i++) {
    try {
      const browser = await puppeteer.launch(CONFIG);
      browserPool.push(browser);
    } catch (error) {
      console.error('Failed to initialize browser:', error);
    }
  }
  
  isPoolInitialized = true;
  console.log(`🛠️ Browser pool initialized (${browserPool.length} instances)`);
};

const getBrowser = async () => {
  if (!isPoolInitialized) await initBrowserPool();
  
  while (browserPool.length === 0) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return browserPool.pop();
};

const releaseBrowser = (browser) => {
  if (browserPool.length < POOL_SIZE) {
    browserPool.push(browser);
  } else {
    browser.close().catch(console.error);
  }
};

// Regularly restart browsers to prevent memory leaks
setInterval(() => {
  console.log('🔄 Refreshing browser pool...');
  
  Promise.all(browserPool.map(browser => browser.close()))
    .catch(console.error)
    .finally(() => {
      browserPool = [];
      isPoolInitialized = false;
      initBrowserPool();
    });
}, 1000 * 60 * 60); // Every hour

// Helpers
const isValidUrl = (url) => {
  const regex = /^(https?:\/\/)?(www\.)?doujindesu\.tv\/doujin\/page\/\d+\/$/;
  return regex.test(url);
};

const isValidSlug = (slug) => {
  return slug && !slug.includes('/');
};

const createPage = async (browser, interceptRequests = true) => {
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders(HEADERS);
  
  if (interceptRequests) {
    await page.setRequestInterception(true);
    page.on('request', req => {
      const resourceType = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media', 'other'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });
  }

  // Disable JavaScript where possible to reduce load
  // await page.setJavaScriptEnabled(false); // Uncomment if the site works without JS

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    
    // Block trackers and analytics
    window.ga = function() {};
    window.gtag = function() {};
    window._gaq = { push: function() {} };
  });

  return page;
};

const fetchImageBuffer = async (url, referer = urlBase, retryCount = 0) => {
  // Increase timeout for large images (20 seconds)
  const { controller, timeout } = createTimeout(20000);
  
  try {
    const response = await fetch(url, {
      headers: {
        'Referer': referer,
        'User-Agent': HEADERS['User-Agent'],
      },
      signal: controller.signal
    });

    if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (error) {
    // Clear timeout to prevent memory leak
    clearTimeout(timeout);
    
    // Retry logic - attempt up to 3 times with increasing delay
    if (retryCount < 3) {
      console.log(`Retrying fetch for ${url} (attempt ${retryCount + 1})...`);
      // Exponential backoff: 1s, 2s, 4s
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, retryCount)));
      return fetchImageBuffer(url, referer, retryCount + 1);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

// Enhanced database helpers with error handling and retries
const getComicFromDB = async (slug, retryCount = 0) => {
  try {
    const results = await sql`
      SELECT image_url FROM comics WHERE slug = ${slug}
    `;
    
    if (results?.length > 0 && results[0].image_url) {
      return results[0].image_url.split(',');
    }
    return null;
  } catch (error) {
    console.error('Database error:', error);
    
    // Retry logic for transient database errors
    if (retryCount < 2) {
      console.log(`Retrying database query for slug ${slug} (attempt ${retryCount + 1})...`);
      await new Promise(resolve => setTimeout(resolve, 500 * (retryCount + 1)));
      return getComicFromDB(slug, retryCount + 1);
    }
    
    return null;
  }
};

const saveComicToDB = async (slug, fullUrl, imageUrls, retryCount = 0) => {
  if (!imageUrls || imageUrls.length === 0) {
    console.error('Attempted to save empty image URLs array');
    return false;
  }
  
  try {
    const validUrls = imageUrls.filter(url => url !== null && url !== undefined);
    
    if (validUrls.length === 0) {
      console.error('No valid image URLs to save');
      return false;
    }

    await sql`
      INSERT INTO comics (slug, url, image_url, total_images)
      VALUES (
        ${slug}, 
        ${fullUrl}, 
        ${validUrls.join(',')}, 
        ${validUrls.length}
      )
      ON CONFLICT (slug) DO UPDATE SET
        image_url = ${validUrls.join(',')},
        total_images = ${validUrls.length}
    `;
    
    console.log(`✅ Saved ${validUrls.length} images to database for slug: ${slug}`);
    return true;
  } catch (error) {
    console.error(`Failed to save to database (attempt ${retryCount + 1}):`, error);
    
    if (retryCount < 2) {
      await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
      return saveComicToDB(slug, fullUrl, imageUrls, retryCount + 1);
    }
    
    return false;
  }
};


// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Global error handler:', err);
  res.status(500).json({
    status: 'error',
    message: err.message || 'Internal server error'
  });
});

// Variabel untuk mengelola status lock
let autoFetchInProgress = false;
let autoFetchQueue = [];
let currentAutoFetchOperation = null;

app.get('/auto-json', async (req, res) => {
  const jsonFilePath = req.query.file || 'slug.json';
  // Set timeout ke nilai yang sangat besar (7 hari) agar tidak timeout sampai selesai
  const timeout = req.query.timeout ? parseInt(req.query.timeout) * 1000 : 7 * 24 * 60 * 60 * 1000; // Default 7 hari
  
  // Jika ada operasi auto-fetch yang sedang berjalan, tolak request baru
  if (autoFetchInProgress) {
    return res.status(429).json({ 
      success: false, 
      error: 'Operasi auto-fetch lain sedang berjalan, silakan coba lagi nanti',
      currentOperation: {
        file: currentAutoFetchOperation?.file,
        startedAt: currentAutoFetchOperation?.startedAt,
        elapsedSeconds: currentAutoFetchOperation ? 
          Math.floor((Date.now() - currentAutoFetchOperation.startedAt) / 1000) : 0
      }
    });
  }

  // Set lock
  autoFetchInProgress = true;
  currentAutoFetchOperation = {
    file: jsonFilePath,
    startedAt: Date.now()
  };

  // Fungsi untuk merilis lock ketika operasi selesai
  const releaseLock = () => {
    autoFetchInProgress = false;
    currentAutoFetchOperation = null;
  };

  try {
    // Baca file JSON
    let jsonData;
    try {
      const rawData = await fs.promises.readFile(jsonFilePath, 'utf8');
      jsonData = JSON.parse(rawData);
      
      if (!jsonData.success || !Array.isArray(jsonData.chapters)) {
        releaseLock();
        return res.status(400).json({
          success: false,
          error: 'Format JSON tidak valid. Harus memiliki properti "success" dan array "chapters"'
        });
      }
    } catch (err) {
      releaseLock();
      return res.status(400).json({
        success: false,
        error: `Gagal membaca file JSON: ${err.message}`
      });
    }

    // Setup abort controller untuk timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.log(`Auto-fetch timeout setelah ${timeout/1000} detik untuk file "${jsonFilePath}"`);
      controller.abort();
    }, timeout);
    
    // Fungsi untuk memeriksa apakah masih ada chapter yang tersisa
    const checkRemainingChapters = () => {
      return jsonData.chapters && jsonData.chapters.length > 0;
    };

    // Simpan semua hasil pemrosesan
    const allResults = [];
    
    // Proses komik dengan chapter-nya secara paralel dengan batas konkurensi
    const processChapters = async (chapters, concurrencyLimit = 3) => {
      const results = [];
      const processed = []; // Track processed chapters for removal
      const chunks = [];
      
      // Bagi chapters ke dalam chunk sesuai concurrencyLimit
      for (let i = 0; i < chapters.length; i += concurrencyLimit) {
        chunks.push(chapters.slice(i, i + concurrencyLimit));
      }
      
      console.log(`Memproses ${chapters.length} chapter dalam ${chunks.length} batch`);
      
      // Proses setiap chunk secara sekuensial
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const chunk = chunks[chunkIndex];
        console.log(`Memproses batch ${chunkIndex + 1}/${chunks.length} dengan ${chunk.length} chapter`);
        
        try {
          // Periksa apakah operasi sudah dibatalkan, tetapi jika masih ada chapter,
          // reset timeout dan lanjutkan proses
          if (controller.signal.aborted) {
            console.log('Operasi timeout, memeriksa apakah masih ada chapter tersisa...');
            if (checkRemainingChapters()) {
              console.log('Masih ada chapter tersisa, reset timeout dan lanjutkan proses');
              // Reset timeout dan controller
              clearTimeout(timeoutId);
              controller.signal.aborted = false; // Reset sinyal abort
              console.log(`Melanjutkan pemrosesan dengan timeout baru: ${timeout/1000} detik`);
            } else {
              console.log('Tidak ada chapter tersisa, menghentikan pemrosesan');
              throw new Error('Operation aborted - no chapters remaining');
            }
          }
          
          const chunkPromises = chunk.map(async (chapter, chapterIndex) => {
            try {
              const { slug, title } = chapter;
              
              if (!slug) {
                return {
                  title: title || 'Unknown',
                  slug: slug || 'Unknown',
                  status: 'failed',
                  reason: 'Slug tidak valid'
                };
              }
              
              console.log(`Memproses chapter: ${title} (${slug})`);
              
              // Gunakan endpoint get-comic dengan slug
              const response = await fetch(`http://127.0.0.1:5000/get-comic?url=${encodeURIComponent(slug)}`, {
                signal: controller.signal,
                timeout: 15000 // 15 detik timeout per request chapter
              });
              
              const data = await response.json();
              
              if (!data.success) {
                return {
                  title,
                  slug,
                  status: 'failed',
                  reason: data.error || 'Gagal memproses chapter'
                };
              }
              
              // Jika berhasil, simpan ke database atau upload ke CDN di sini
              // Contoh:
              // await uploadToCDN(data.images);
              // await saveToDatabase(slug, title, data);
              
              // Tandai chapter ini sebagai berhasil diproses untuk dihapus nanti
              processed.push({
                index: chunkIndex * concurrencyLimit + chapterIndex,
                chapter
              });
              
              // Tambahkan ke hasil keseluruhan
              allResults.push({
                title,
                slug,
                status: 'ok',
                imagesCount: data.images ? data.images.length : 0
              });
              
              return {
                title,
                slug,
                status: 'ok',
                imagesCount: data.images ? data.images.length : 0
              };
            } catch (chapterError) {
              console.error(`Error saat memproses chapter ${chapter.title}:`, chapterError);
              
              // Jika error adalah timeout atau network, coba ulangi sekali
              if (chapterError.name === 'AbortError' || 
                  chapterError.name === 'TimeoutError' || 
                  chapterError.message.includes('network') ||
                  chapterError.message.includes('timeout')) {
                
                console.log(`Mencoba ulang chapter: ${title} (${slug}) setelah error: ${chapterError.message}`);
                
                try {
                  // Tunggu sebentar sebelum mencoba lagi
                  await new Promise(resolve => setTimeout(resolve, 5000));
                  
                  // Coba lagi request
                  const retryResponse = await fetch(`http://127.0.0.1:5000/get-comic?url=${encodeURIComponent(slug)}`, {
                    signal: controller.signal,
                    timeout: 20000 // Tambah timeout menjadi 20 detik untuk coba ulang
                  });
                  
                  const retryData = await retryResponse.json();
                  
                  if (!retryData.success) {
                    return {
                      title,
                      slug,
                      status: 'failed',
                      reason: retryData.error || 'Gagal memproses chapter (percobaan ulang)'
                    };
                  }
                  
                  // Jika berhasil pada percobaan ulang
                  processed.push({
                    index: chunkIndex * concurrencyLimit + chapterIndex,
                    chapter
                  });
                  
                  // Tambahkan ke hasil keseluruhan
                  allResults.push({
                    title,
                    slug,
                    status: 'ok (retry)',
                    imagesCount: retryData.images ? retryData.images.length : 0
                  });
                  
                  return {
                    title,
                    slug,
                    status: 'ok (retry)',
                    imagesCount: retryData.images ? retryData.images.length : 0
                  };
                } catch (retryError) {
                  console.error(`Gagal percobaan ulang untuk chapter ${title}:`, retryError);
                  return {
                    title: chapter.title || 'Unknown',
                    slug: chapter.slug || 'Unknown',
                    status: 'retry_failed',
                    reason: retryError.message
                  };
                }
              }
              
              return {
                title: chapter.title || 'Unknown',
                slug: chapter.slug || 'Unknown',
                status: chapterError.name === 'AbortError' ? 'aborted' : 'processing_error',
                reason: chapterError.message
              };
            }
          });
          
          // Tunggu semua chapter dalam chunk selesai diproses
          const chunkResults = await Promise.all(chunkPromises);
          results.push(...chunkResults);
          
          // Perbarui file JSON setelah setiap batch selesai untuk menghapus chapter yang sudah diproses
          if (processed.length > 0) {
            try {
              // Urutkan indeks dari yang terbesar ke yang terkecil agar tidak ada masalah saat menghapus
              processed.sort((a, b) => b.index - a.index);
              
              // Hapus chapter yang sudah diproses dari jsonData
              for (const item of processed) {
                jsonData.chapters.splice(item.index, 1);
              }
              
              // Tulis kembali file JSON yang sudah diperbarui
              await fs.promises.writeFile(
                jsonFilePath, 
                JSON.stringify(jsonData, null, 2), 
                'utf8'
              );
              
              console.log(`Berhasil menghapus ${processed.length} chapter yang sudah diproses dari file JSON`);
              
              // Reset array processed
              processed.length = 0;
            } catch (updateError) {
              console.error(`Gagal memperbarui file JSON: ${updateError.message}`);
              // Tetap lanjutkan proses meski update file gagal
            }
          }
        } catch (chunkError) {
          console.error(`Error saat memproses batch ${chunkIndex + 1}:`, chunkError);
          // Jika ini error abort, hentikan pemrosesan
          if (chunkError.name === 'AbortError' || chunkError.message === 'Operation aborted') {
            throw chunkError; // Re-throw untuk menghentikan proses
          }
          // Untuk error lain, coba lanjutkan ke batch berikutnya
        }
      }
      
      return results;
    };

    try {
      // Loop sampai semua chapter selesai diproses atau terjadi error fatal
      while (jsonData.chapters && jsonData.chapters.length > 0) {
        console.log(`Mulai proses batch dengan ${jsonData.chapters.length} chapter tersisa`);
        // Proses batch chapter yang tersedia
        const batchResults = await processChapters(jsonData.chapters);
        console.log(`Batch selesai, ${jsonData.chapters.length} chapter tersisa`);
        
        // Jika tidak ada chapter tersisa, keluar dari loop
        if (jsonData.chapters.length === 0) {
          console.log('Semua chapter telah diproses, keluar dari loop');
          break;
        }
        
        // Jika tidak ada progress yang dibuat dalam batch ini, mungkin ada masalah
        if (batchResults.length === 0) {
          console.log('Tidak ada progress yang dibuat dalam batch ini, kemungkinan ada masalah');
          // Tunggu sebentar sebelum mencoba batch berikutnya
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
      
      clearTimeout(timeoutId);

      // Lepas lock sebelum mengirim respons
      releaseLock();

      res.json({
        success: true,
        page: jsonData.page || 1,
        totalProcessed: allResults.length,
        totalRemaining: jsonData.chapters ? jsonData.chapters.length : 0,
        results: allResults
      });
    } catch (error) {
      // Tangani error yang tidak tertangkap
      console.error('Auto-fetch error:', error);
      
      // Jika operasi dibatalkan tapi masih ada chapter tersisa
      if ((error.name === 'AbortError' || error.message.includes('Operation aborted')) && 
          jsonData.chapters && jsonData.chapters.length > 0) {
        // Tunggu beberapa detik
        await new Promise(resolve => setTimeout(resolve, 10000));
        
        console.log(`Mencoba kembali proses dengan ${jsonData.chapters.length} chapter tersisa`);
        
        try {
          // Reset controller untuk mencoba lagi
          const newController = new AbortController();
          controller = newController;
          
          // Buat timeout baru
          clearTimeout(timeoutId);
          const newTimeoutId = setTimeout(() => {
            console.log(`Timeout baru setelah ${timeout/1000} detik untuk file "${jsonFilePath}"`);
            newController.abort();
          }, timeout);
          
          // Proses ulang chapter yang tersisa
          await processChapters(jsonData.chapters);
          
          clearTimeout(newTimeoutId);
          releaseLock();
          
          return res.json({
            success: true,
            page: jsonData.page || 1,
            message: 'Berhasil melanjutkan setelah timeout',
            totalProcessed: allResults.length,
            totalRemaining: jsonData.chapters.length,
            results: allResults
          });
        } catch (retryError) {
          console.error('Error saat mencoba kembali:', retryError);
          releaseLock();
          
          return res.status(202).json({
            success: false,
            page: jsonData.page || 1,
            error: 'Gagal melanjutkan setelah timeout',
            totalRemaining: jsonData.chapters.length,
            partialResults: allResults || []
          });
        }
      }
      
      clearTimeout(timeoutId);
      releaseLock();
      
      res.status(500).json({ 
        success: false, 
        error: error.message || 'Unknown error',
        totalRemaining: jsonData.chapters ? jsonData.chapters.length : 'unknown'
      });
    }
  } catch (error) {
    // Tangani error yang tidak tertangkap
    console.error('Auto-fetch error:', error);
    releaseLock();
    
    res.status(500).json({ 
      success: false, 
      error: error.name === 'AbortError' ? 'Operation timed out' : error.message 
    });
  }
});

app.get('/auto-fetch', async (req, res) => {
  const query = req.query.q;
  const page = parseInt(req.query.pages) || 1; // Menggunakan parameter sebagai nomor halaman spesifik
  if (!query) return res.status(400).json({ error: 'Query diperlukan' });

  // Jika ada operasi auto-fetch yang sedang berjalan, tolak request baru
  if (autoFetchInProgress) {
    return res.status(429).json({ 
      success: false, 
      error: 'Operasi auto-fetch lain sedang berjalan, silakan coba lagi nanti',
      currentOperation: {
        query: currentAutoFetchOperation?.query,
        startedAt: currentAutoFetchOperation?.startedAt,
        elapsedSeconds: currentAutoFetchOperation ? 
          Math.floor((Date.now() - currentAutoFetchOperation.startedAt) / 1000) : 0
      }
    });
  }

  // Set lock
  autoFetchInProgress = true;
  currentAutoFetchOperation = {
    query,
    page,
    startedAt: Date.now()
  };

  // Fungsi untuk merilis lock ketika operasi selesai
  const releaseLock = () => {
    autoFetchInProgress = false;
    currentAutoFetchOperation = null;
  };

  try {
    // 1. Set timeout untuk seluruh operasi
    const TIMEOUT = req.query.timeout ? parseInt(req.query.timeout) * 1000 : 300000; // Default 5 menit (300000 ms), bisa dikustomisasi
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.log(`Auto-fetch timeout setelah ${TIMEOUT/1000} detik untuk query "${query}" halaman ${page}`);
      controller.abort();
    }, TIMEOUT);

    // 2. Fetch hasil pencarian untuk halaman spesifik yang dipilih
    console.log(`Memulai auto-fetch untuk query "${query}" pada halaman ${page}`);
    
    // Hanya ambil satu halaman yang ditentukan oleh parameter 'pages'
    const searchResponse = await fetch(`http://127.0.0.1:5000/search?q=${encodeURIComponent(query)}&page=${page}`, {
      signal: controller.signal,
      timeout: 5000 // 5 detik timeout per request
    });
    
    const searchData = await searchResponse.json();
    const allResults = searchData?.results || [];
    
    if (allResults.length === 0) {
      clearTimeout(timeoutId);
      releaseLock(); // Lepas lock
      return res.json({ success: true, totalFetched: 0, results: [] });
    }

    // Hapus duplikat berdasarkan link
    const uniqueResults = Array.from(
      new Map(allResults.map(item => [item.link, item])).values()
    );

    // 3. Fetch semua detail secara konkuren
    const detailPromises = uniqueResults.map(item => {
      const slug = item.link.replace(/^.*\/([^\/]+)\/?$/, '$1');
      return fetch(`http://127.0.0.1:5000/detail?url=${encodeURIComponent(slug)}`, {
        signal: controller.signal,
        timeout: 5000
      })
        .then(r => r.json())
        .then(data => ({ 
          success: data.success, 
          detail: data.detail || {}, 
          originalTitle: item.title,
          originalLink: item.link
        }))
        .catch(e => ({ 
          success: false, 
          originalTitle: item.title,
          originalLink: item.link, 
          error: e.message 
        }));
    });

    const detailResults = await Promise.all(detailPromises);
    
    // 4. Proses semua komik dengan chapter-nya secara paralel dengan batas konkurensi
    const processComics = async (comics, concurrencyLimit = 3) => {
      const results = [];
      const chunks = [];
      
      // Bagi comics ke dalam chunk sesuai concurrencyLimit
      for (let i = 0; i < comics.length; i += concurrencyLimit) {
        chunks.push(comics.slice(i, i + concurrencyLimit));
      }
      
      console.log(`Memproses ${comics.length} komik dalam ${chunks.length} batch`);
      
      // Proses setiap chunk secara sekuensial
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const chunk = chunks[chunkIndex];
        console.log(`Memproses batch ${chunkIndex + 1}/${chunks.length} dengan ${chunk.length} komik`);
        
        try {
          // Periksa apakah operasi sudah dibatalkan
          if (controller.signal.aborted) {
            console.log('Operasi telah dibatalkan, menghentikan pemrosesan');
            throw new Error('Operation aborted');
          }
          
          const chunkPromises = chunk.map(async (result, comicIndex) => {
            try {
              if (!result.success) {
                return { 
                  title: result.originalTitle, 
                  link: result.originalLink,
                  status: 'detail_failed',
                  reason: result.error || 'Unknown error' 
                };
              }
      
              const detail = result.detail;
              const chapters = detail.chapters || [];
              
              // Proses chapter dalam batch untuk menghindari overload server
              const BATCH_SIZE = 5;
              const chapterResults = [];
              
              console.log(`Komik #${comicIndex + 1} (${detail.title || result.originalTitle}): Memproses ${chapters.length} chapter`);
              
              for (let i = 0; i < chapters.length; i += BATCH_SIZE) {
                // Periksa apakah operasi sudah dibatalkan
                if (controller.signal.aborted) {
                  console.log('Operasi telah dibatalkan, menghentikan pemrosesan chapter');
                  throw new Error('Operation aborted');
                }
                
                const batchChapters = chapters.slice(i, i + BATCH_SIZE);
                console.log(`Komik #${comicIndex + 1}: Memproses chapter batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(chapters.length/BATCH_SIZE)}`);
                
                const batchPromises = batchChapters.map(chap => {
                  const chapSlug = chap.chapterLink.replace(/^\/|\/$/g, '');
                  return fetch(`http://127.0.0.1:5000/get-comic?url=${encodeURIComponent(chapSlug)}`, {
                    signal: controller.signal,
                    timeout: 15000 // 15 detik timeout per request chapter (lebih lama karena fetch gambar)
                  })
                    .then(r => r.json())
                    .then(data => ({
                      chapter: chap.chapterTitle,
                      status: data.success ? 'ok' : 'failed',
                      reason: data.error || null
                    }))
                    .catch(e => {
                      console.error(`Error saat mengambil chapter ${chap.chapterTitle}:`, e.message);
                      return {
                        chapter: chap.chapterTitle,
                        status: e.name === 'AbortError' ? 'aborted' : 'fetch_error',
                        reason: e.message
                      };
                    });
                });
                
                try {
                  // Tunggu batch saat ini selesai
                  const batchResults = await Promise.all(batchPromises);
                  chapterResults.push(...batchResults);
                } catch (batchError) {
                  console.error(`Error dalam batch chapter:`, batchError);
                  // Lanjutkan meskipun ada error dalam batch
                }
              }
      
              return {
                title: detail.title || result.originalTitle,
                link: detail.url || result.originalLink,
                chaptersFetched: chapterResults.length,
                totalChapters: chapters.length,
                chapters: chapterResults
              };
            } catch (comicError) {
              console.error(`Error saat memproses komik ${result.originalTitle}:`, comicError);
              return {
                title: result.originalTitle,
                link: result.originalLink,
                status: comicError.name === 'AbortError' ? 'aborted' : 'processing_error',
                reason: comicError.message
              };
            }
          });
      
          // Tunggu semua komik dalam chunk selesai diproses
          const chunkResults = await Promise.all(chunkPromises);
          results.push(...chunkResults);
        } catch (chunkError) {
          console.error(`Error saat memproses batch ${chunkIndex + 1}:`, chunkError);
          // Jika ini error abort, hentikan pemrosesan
          if (chunkError.name === 'AbortError' || chunkError.message === 'Operation aborted') {
            throw chunkError; // Re-throw untuk menghentikan proses
          }
          // Untuk error lain, coba lanjutkan ke batch berikutnya
        }
      }
      
      return results;
    };

    try {
      const finalResults = await processComics(detailResults);
      clearTimeout(timeoutId);

      // Lepas lock sebelum mengirim respons
      releaseLock();

      res.json({
        success: true,
        page: page,
        totalFetched: finalResults.length,
        results: finalResults
      });
    } catch (error) {
      // Tangani error yang tidak tertangkap
      console.error('Auto-fetch error:', error);
      
      // Jika operasi dibatalkan, coba kirim hasil parsial
      if (error.name === 'AbortError' || error.message === 'Operation aborted') {
        const partialResults = detailResults.map(result => {
          if (!result.success) {
            return {
              title: result.originalTitle,
              link: result.originalLink,
              status: 'detail_failed',
              reason: result.error || 'Unknown error'
            };
          }
          
          return {
            title: result.detail.title || result.originalTitle,
            link: result.detail.url || result.originalLink,
            status: 'partial',
            reason: 'Operation timed out, hasil parsial'
          };
        });
        
        // Lepas lock
        releaseLock();
        
        return res.status(202).json({
          success: false,
          page: page,
          error: 'Operation timed out',
          message: 'Waktu operasi habis, mengembalikan hasil parsial',
          partialResults: partialResults
        });
      }
      
      // Lepas lock jika terjadi error
      releaseLock();
      
      res.status(500).json({ 
        success: false, 
        error: error.message || 'Unknown error'
      });
    }
  } catch (error) {
    // Tangani error yang tidak tertangkap
    console.error('Auto-fetch error:', error);
    
    // Lepas lock jika terjadi error
    releaseLock();
    
    res.status(500).json({ 
      success: false, 
      error: error.name === 'AbortError' ? 'Operation timed out' : error.message 
    });
  }
});

app.get('/auto-json', async (req, res) => {
  const jsonFilePath = req.query.file || 'slug.json';
  // Set timeout ke nilai yang sangat besar (7 hari) agar tidak timeout sampai selesai
  const timeout = req.query.timeout ? parseInt(req.query.timeout) * 1000 : 7 * 24 * 60 * 60 * 1000; // Default 7 hari
  
  // Jika ada operasi auto-fetch yang sedang berjalan, tolak request baru
  if (autoFetchInProgress) {
    return res.status(429).json({ 
      success: false, 
      error: 'Operasi auto-fetch lain sedang berjalan, silakan coba lagi nanti',
      currentOperation: {
        file: currentAutoFetchOperation?.file,
        startedAt: currentAutoFetchOperation?.startedAt,
        elapsedSeconds: currentAutoFetchOperation ? 
          Math.floor((Date.now() - currentAutoFetchOperation.startedAt) / 1000) : 0
      }
    });
  }

  // Set lock
  autoFetchInProgress = true;
  currentAutoFetchOperation = {
    file: jsonFilePath,
    startedAt: Date.now()
  };

  // Fungsi untuk merilis lock ketika operasi selesai
  const releaseLock = () => {
    autoFetchInProgress = false;
    currentAutoFetchOperation = null;
  };

  try {
    // Baca file JSON
    let jsonData;
    try {
      const rawData = await fs.promises.readFile(jsonFilePath, 'utf8');
      jsonData = JSON.parse(rawData);
      
      if (!jsonData.success || !Array.isArray(jsonData.chapters)) {
        releaseLock();
        return res.status(400).json({
          success: false,
          error: 'Format JSON tidak valid. Harus memiliki properti "success" dan array "chapters"'
        });
      }
    } catch (err) {
      releaseLock();
      return res.status(400).json({
        success: false,
        error: `Gagal membaca file JSON: ${err.message}`
      });
    }

    // Setup abort controller untuk timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.log(`Auto-fetch timeout setelah ${timeout/1000} detik untuk file "${jsonFilePath}"`);
      controller.abort();
    }, timeout);
    
    // Fungsi untuk memeriksa apakah masih ada chapter yang tersisa
    const checkRemainingChapters = () => {
      return jsonData.chapters && jsonData.chapters.length > 0;
    };

    // Simpan semua hasil pemrosesan
    const allResults = [];
    
    // Proses komik dengan chapter-nya secara paralel dengan batas konkurensi
    const processChapters = async (chapters, concurrencyLimit = 3) => {
      const results = [];
      const processed = []; // Track processed chapters for removal
      const chunks = [];
      
      // Bagi chapters ke dalam chunk sesuai concurrencyLimit
      for (let i = 0; i < chapters.length; i += concurrencyLimit) {
        chunks.push(chapters.slice(i, i + concurrencyLimit));
      }
      
      console.log(`Memproses ${chapters.length} chapter dalam ${chunks.length} batch`);
      
      // Proses setiap chunk secara sekuensial
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const chunk = chunks[chunkIndex];
        console.log(`Memproses batch ${chunkIndex + 1}/${chunks.length} dengan ${chunk.length} chapter`);
        
        try {
          // Periksa apakah operasi sudah dibatalkan, tetapi jika masih ada chapter,
          // reset timeout dan lanjutkan proses
          if (controller.signal.aborted) {
            console.log('Operasi timeout, memeriksa apakah masih ada chapter tersisa...');
            if (checkRemainingChapters()) {
              console.log('Masih ada chapter tersisa, reset timeout dan lanjutkan proses');
              // Reset timeout dan controller
              clearTimeout(timeoutId);
              controller.signal.aborted = false; // Reset sinyal abort
              console.log(`Melanjutkan pemrosesan dengan timeout baru: ${timeout/1000} detik`);
            } else {
              console.log('Tidak ada chapter tersisa, menghentikan pemrosesan');
              throw new Error('Operation aborted - no chapters remaining');
            }
          }
          
          const chunkPromises = chunk.map(async (chapter, chapterIndex) => {
            try {
              const { slug, title } = chapter;
              
              if (!slug) {
                return {
                  title: title || 'Unknown',
                  slug: slug || 'Unknown',
                  status: 'failed',
                  reason: 'Slug tidak valid'
                };
              }
              
              console.log(`Memproses chapter: ${title} (${slug})`);
              
              // Gunakan endpoint get-comic dengan slug
              const response = await fetch(`http://127.0.0.1:5000/get-comic?url=${encodeURIComponent(slug)}`, {
                signal: controller.signal,
                timeout: 15000 // 15 detik timeout per request chapter
              });
              
              const data = await response.json();
              
              if (!data.success) {
                return {
                  title,
                  slug,
                  status: 'failed',
                  reason: data.error || 'Gagal memproses chapter'
                };
              }
              
              // Jika berhasil, simpan ke database atau upload ke CDN di sini
              // Contoh:
              // await uploadToCDN(data.images);
              // await saveToDatabase(slug, title, data);
              
              // Tandai chapter ini sebagai berhasil diproses untuk dihapus nanti
              processed.push({
                index: chunkIndex * concurrencyLimit + chapterIndex,
                chapter
              });
              
              // Tambahkan ke hasil keseluruhan
              allResults.push({
                title,
                slug,
                status: 'ok',
                imagesCount: data.images ? data.images.length : 0
              });
              
              return {
                title,
                slug,
                status: 'ok',
                imagesCount: data.images ? data.images.length : 0
              };
            } catch (chapterError) {
              console.error(`Error saat memproses chapter ${chapter.title}:`, chapterError);
              
              // Jika error adalah timeout atau network, coba ulangi sekali
              if (chapterError.name === 'AbortError' || 
                  chapterError.name === 'TimeoutError' || 
                  chapterError.message.includes('network') ||
                  chapterError.message.includes('timeout')) {
                
                console.log(`Mencoba ulang chapter: ${title} (${slug}) setelah error: ${chapterError.message}`);
                
                try {
                  // Tunggu sebentar sebelum mencoba lagi
                  await new Promise(resolve => setTimeout(resolve, 5000));
                  
                  // Coba lagi request
                  const retryResponse = await fetch(`http://127.0.0.1:5000/get-comic?url=${encodeURIComponent(slug)}`, {
                    signal: controller.signal,
                    timeout: 20000 // Tambah timeout menjadi 20 detik untuk coba ulang
                  });
                  
                  const retryData = await retryResponse.json();
                  
                  if (!retryData.success) {
                    return {
                      title,
                      slug,
                      status: 'failed',
                      reason: retryData.error || 'Gagal memproses chapter (percobaan ulang)'
                    };
                  }
                  
                  // Jika berhasil pada percobaan ulang
                  processed.push({
                    index: chunkIndex * concurrencyLimit + chapterIndex,
                    chapter
                  });
                  
                  // Tambahkan ke hasil keseluruhan
                  allResults.push({
                    title,
                    slug,
                    status: 'ok (retry)',
                    imagesCount: retryData.images ? retryData.images.length : 0
                  });
                  
                  return {
                    title,
                    slug,
                    status: 'ok (retry)',
                    imagesCount: retryData.images ? retryData.images.length : 0
                  };
                } catch (retryError) {
                  console.error(`Gagal percobaan ulang untuk chapter ${title}:`, retryError);
                  return {
                    title: chapter.title || 'Unknown',
                    slug: chapter.slug || 'Unknown',
                    status: 'retry_failed',
                    reason: retryError.message
                  };
                }
              }
              
              return {
                title: chapter.title || 'Unknown',
                slug: chapter.slug || 'Unknown',
                status: chapterError.name === 'AbortError' ? 'aborted' : 'processing_error',
                reason: chapterError.message
              };
            }
          });
          
          // Tunggu semua chapter dalam chunk selesai diproses
          const chunkResults = await Promise.all(chunkPromises);
          results.push(...chunkResults);
          
          // Perbarui file JSON setelah setiap batch selesai untuk menghapus chapter yang sudah diproses
          if (processed.length > 0) {
            try {
              // Urutkan indeks dari yang terbesar ke yang terkecil agar tidak ada masalah saat menghapus
              processed.sort((a, b) => b.index - a.index);
              
              // Hapus chapter yang sudah diproses dari jsonData
              for (const item of processed) {
                jsonData.chapters.splice(item.index, 1);
              }
              
              // Tulis kembali file JSON yang sudah diperbarui
              await fs.promises.writeFile(
                jsonFilePath, 
                JSON.stringify(jsonData, null, 2), 
                'utf8'
              );
              
              console.log(`Berhasil menghapus ${processed.length} chapter yang sudah diproses dari file JSON`);
              
              // Reset array processed
              processed.length = 0;
            } catch (updateError) {
              console.error(`Gagal memperbarui file JSON: ${updateError.message}`);
              // Tetap lanjutkan proses meski update file gagal
            }
          }
        } catch (chunkError) {
          console.error(`Error saat memproses batch ${chunkIndex + 1}:`, chunkError);
          // Jika ini error abort, hentikan pemrosesan
          if (chunkError.name === 'AbortError' || chunkError.message === 'Operation aborted') {
            throw chunkError; // Re-throw untuk menghentikan proses
          }
          // Untuk error lain, coba lanjutkan ke batch berikutnya
        }
      }
      
      return results;
    };

    try {
      // Loop sampai semua chapter selesai diproses atau terjadi error fatal
      while (jsonData.chapters && jsonData.chapters.length > 0) {
        console.log(`Mulai proses batch dengan ${jsonData.chapters.length} chapter tersisa`);
        // Proses batch chapter yang tersedia
        const batchResults = await processChapters(jsonData.chapters);
        console.log(`Batch selesai, ${jsonData.chapters.length} chapter tersisa`);
        
        // Jika tidak ada chapter tersisa, keluar dari loop
        if (jsonData.chapters.length === 0) {
          console.log('Semua chapter telah diproses, keluar dari loop');
          break;
        }
        
        // Jika tidak ada progress yang dibuat dalam batch ini, mungkin ada masalah
        if (batchResults.length === 0) {
          console.log('Tidak ada progress yang dibuat dalam batch ini, kemungkinan ada masalah');
          // Tunggu sebentar sebelum mencoba batch berikutnya
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
      
      clearTimeout(timeoutId);

      // Lepas lock sebelum mengirim respons
      releaseLock();

      res.json({
        success: true,
        page: jsonData.page || 1,
        totalProcessed: allResults.length,
        totalRemaining: jsonData.chapters ? jsonData.chapters.length : 0,
        results: allResults
      });
    } catch (error) {
      // Tangani error yang tidak tertangkap
      console.error('Auto-fetch error:', error);
      
      // Jika operasi dibatalkan tapi masih ada chapter tersisa
      if ((error.name === 'AbortError' || error.message.includes('Operation aborted')) && 
          jsonData.chapters && jsonData.chapters.length > 0) {
        // Tunggu beberapa detik
        await new Promise(resolve => setTimeout(resolve, 10000));
        
        console.log(`Mencoba kembali proses dengan ${jsonData.chapters.length} chapter tersisa`);
        
        try {
          // Reset controller untuk mencoba lagi
          const newController = new AbortController();
          controller = newController;
          
          // Buat timeout baru
          clearTimeout(timeoutId);
          const newTimeoutId = setTimeout(() => {
            console.log(`Timeout baru setelah ${timeout/1000} detik untuk file "${jsonFilePath}"`);
            newController.abort();
          }, timeout);
          
          // Proses ulang chapter yang tersisa
          await processChapters(jsonData.chapters);
          
          clearTimeout(newTimeoutId);
          releaseLock();
          
          return res.json({
            success: true,
            page: jsonData.page || 1,
            message: 'Berhasil melanjutkan setelah timeout',
            totalProcessed: allResults.length,
            totalRemaining: jsonData.chapters.length,
            results: allResults
          });
        } catch (retryError) {
          console.error('Error saat mencoba kembali:', retryError);
          releaseLock();
          
          return res.status(202).json({
            success: false,
            page: jsonData.page || 1,
            error: 'Gagal melanjutkan setelah timeout',
            totalRemaining: jsonData.chapters.length,
            partialResults: allResults || []
          });
        }
      }
      
      clearTimeout(timeoutId);
      releaseLock();
      
      res.status(500).json({ 
        success: false, 
        error: error.message || 'Unknown error',
        totalRemaining: jsonData.chapters ? jsonData.chapters.length : 'unknown'
      });
    }
  } catch (error) {
    // Tangani error yang tidak tertangkap
    console.error('Auto-fetch error:', error);
    releaseLock();
    
    res.status(500).json({ 
      success: false, 
      error: error.name === 'AbortError' ? 'Operation timed out' : error.message 
    });
  }
});

// Endpoints
app.get('/doujin', async (req, res) => {
  const pageNumber = req.query.page || 1;
  const targetUrl = `https://doujindesu.tv/doujin/page/${pageNumber}/`;

  if (!isValidUrl(targetUrl)) {
    return res.status(400).json({
      status: 'error',
      message: 'Invalid URL format'
    });
  }

  const cacheKey = `doujin_page_${pageNumber}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return res.json({
      status: 'success',
      data: cached.results,
      totalPages: cached.totalPages,
      source: 'cache'
    });
  }

  let browser;
  try {
    browser = await getBrowser();
    const page = await createPage(browser);
    
    await page.goto(targetUrl, { 
      waitUntil: 'domcontentloaded',
      timeout: DEFAULT_TIMEOUT 
    });

    await page.waitForSelector('.entries', { timeout: DEFAULT_TIMEOUT });

    const results = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('article.entry')).map(entry => {
        const anchor = entry.querySelector('a');
        const href = anchor?.getAttribute('href') || '';
        const slug = href.replace('/manga/', '').replace(/^\/|\/$/g, '');

        return {
          title: entry.querySelector('h3.title span')?.innerText.trim(),
          thumbnail: entry.querySelector('img')?.src,
          type: entry.querySelector('.type')?.innerText.trim(),
          chapter: entry.querySelector('.artists a span')?.innerText.trim(),
          time: entry.querySelector('.dtch')?.innerText.trim(),
          link: slug || null
        };
      });
    });

    // Ambil total halaman dari elemen pagination
    const totalPages = await page.$$eval('nav.pagination ul li a strong', els => {
      let max = 1;
      els.forEach(el => {
        const num = parseInt(el.textContent);
        if (!isNaN(num) && num > max) max = num;
      });
      return max;
    });

    await page.close();
    releaseBrowser(browser);

    const responseData = {
      results,
      totalPages
    };

    cache.set(cacheKey, responseData);
    
    res.set('Cache-Control', 'public, max-age=600');
    res.json({
      status: 'success',
      data: results,
      totalPages,
      source: 'fresh'
    });
  } catch (error) {
    if (browser) releaseBrowser(browser);
    console.error('Error in /doujin:', error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});


app.get('/get-comic', async (req, res) => {
  const slug = req.query.url;
  
  // Handle slug validation
  const cleanSlug = slug?.replace(/^\//, '').replace(/\/$/, '');
  if (!cleanSlug) {
    return res.status(400).json({ error: 'Parameter url/slug wajib' });
  }

  try {
    // 1. Check database first for existing comic
    const dbImages = await getComicFromDB(cleanSlug);
    if (dbImages?.length > 0) {
      return res.json({ 
        success: true,
        images: dbImages,
        cached: true,
        source: 'database'
      });
    }

    // 2. Check memory cache
    const cacheKey = `comic-${cleanSlug}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    // 3. Fetch from source
    let browser, page;
    try {
      browser = await getBrowser();
      // We need to load images here
      page = await createPage(browser, false);
      
      const fullUrl = `${urlBase}${cleanSlug}/`;
      
      await page.goto(fullUrl, {
        waitUntil: 'domcontentloaded',
        timeout: DEFAULT_TIMEOUT
      });

      // Validate the page exists
      const pageTitle = await page.title();
      if (pageTitle.includes('404')) {
        await page.close();
        releaseBrowser(browser);
        return res.status(404).json({ error: 'Comic not found' });
      }

      await page.waitForSelector('#anu img', { timeout: DEFAULT_TIMEOUT });
      
      // Extract image URLs
      const imageUrls = await page.$$eval('#anu img', imgs => 
        imgs.map(img => img.dataset.src || img.src).filter(src => src && src.startsWith('http'))
      );      

      await page.close();
      releaseBrowser(browser);

      // 4. Upload to R2 Storage with improved error handling and retry
      const uploadedUrls = [];
      
      // Process uploads in batches of 3 with proper error handling
      for (let i = 0; i < imageUrls.length; i += 3) {
        const batch = imageUrls.slice(i, i + 3);
        const batchPromises = batch.map(async (url, batchIndex) => {
          const index = i + batchIndex;
          let retries = 0;
          const maxRetries = 2;
          
          while (retries <= maxRetries) {
            try {
              console.log(`Processing image ${index + 1}/${imageUrls.length}`);
              const buffer = await fetchImageBuffer(url);
              const ext = path.extname(url).split('?')[0] || '.jpg';
              const fileName = `${cleanSlug}_${index + 1}${ext}`;
              const uploadResult = await uploadToR2(buffer, `DOUJINSHI/${cleanSlug}/${fileName}`);
              console.log(`✅ Uploaded image ${index + 1}`);
              return uploadResult;
            } catch (uploadErr) {
              retries++;
              if (retries > maxRetries) {
                console.error(`❌ Failed to upload image ${index + 1} after ${maxRetries} retries:`, uploadErr.message);
                return null;
              }
              console.log(`⚠️ Retry ${retries}/${maxRetries} for image ${index + 1}...`);
              // Wait before retrying (exponential backoff)
              await new Promise(resolve => setTimeout(resolve, 1000 * retries));
            }
          }
        });
        
        try {
          const results = await Promise.all(batchPromises);
          uploadedUrls.push(...results.filter(url => url !== null));
        } catch (batchError) {
          console.error(`Batch error (images ${i+1}-${i+3}):`, batchError);
          // Continue with next batch even if this one failed
        }
      }

      // 5. Save to database if uploads successful
      if (uploadedUrls.length > 0) {
        await saveComicToDB(cleanSlug, fullUrl, uploadedUrls);
      }

      const response = {
        success: true,
        images: uploadedUrls,
        cached: false,
        source: 'freshly scraped',
        warning: uploadedUrls.length !== imageUrls.length ? 
          'Beberapa gambar gagal diupload' : undefined
      };
      
      cache.set(cacheKey, response);
      res.set('Cache-Control', 'public, max-age=600');
      return res.json(response);
    } catch (err) {
      if (page) await page.close();
      if (browser) releaseBrowser(browser);
      throw err;
    }
  } catch (err) {
    // Final check if there was a race condition
    const dbImages = await getComicFromDB(cleanSlug);
    if (dbImages?.length > 0) {
      return res.json({ 
        success: true,
        images: dbImages,
        cached: true,
        source: 'database (race condition recovery)'
      });      
    }
    
    console.error('Error in /get-comic:', err);
    res.status(500).json({ 
      error: err.message,
      code: err.code 
    });
  }
});

app.get('/proxy', async (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl) return res.status(400).send('URL gambar diperlukan');

  // Increase proxy timeout to 15 seconds
  const { controller, timeout } = createTimeout(15000);
  
  // Try to get from cache first (memory or R2)
  const urlHash = require('crypto').createHash('md5').update(imageUrl).digest('hex');
  const cacheKey = `proxy-${urlHash}`;
  const cachedUrl = cache.get(cacheKey);
  
  if (cachedUrl) {
    return res.redirect(cachedUrl);
  }

  try {
    // Check if we already have this image in R2 storage
    const fileName = `proxy_${urlHash}.jpg`;
    const existing = await sql`
      SELECT cdn_url FROM thumbnails WHERE filename = ${fileName} AND source_url = ${imageUrl}
    `.catch(() => []);

    if (existing?.length > 0 && existing[0].cdn_url) {
      cache.set(cacheKey, existing[0].cdn_url);
      return res.redirect(existing[0].cdn_url);
    }

    // If not cached, fetch the image
    const response = await fetch(imageUrl, {
      headers: {
        'Referer': urlBase,
        'User-Agent': HEADERS['User-Agent']
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Gambar tidak ditemukan (Status: ${response.status})`);
    }

    const contentType = response.headers.get('content-type');
    if (!contentType?.startsWith('image/')) {
      throw new Error('URL tidak merujuk ke gambar yang valid');
    }

    // For frequently accessed images, store in R2
    const proxyCount = cache.get(`proxy-count-${urlHash}`) || 0;
    if (proxyCount > 3) {
      // This image has been requested multiple times, let's store it
      try {
        const imageBuffer = Buffer.from(await response.arrayBuffer());
        const uploadPath = `proxy/${fileName}`;
        const cdnUrl = await uploadToR2(imageBuffer, uploadPath);
        
      // Save to database
      await sql`
        INSERT INTO thumbnails (filename, source_url, cdn_url)
        VALUES (${fileName}, ${imageUrl}, ${cdnUrl})
        ON CONFLICT (filename) DO UPDATE SET
          cdn_url = EXCLUDED.cdn_url
      `;

        cache.set(cacheKey, cdnUrl);
        return res.redirect(cdnUrl);
      } catch (uploadError) {
        console.error('Failed to upload proxy image:', uploadError);
        // Continue with direct streaming if upload fails
      }
    } else {
      // Increment request counter for this URL
      cache.set(`proxy-count-${urlHash}`, proxyCount + 1);
    }

    // Stream the image directly if not stored
    const bodyStream = Readable.from(response.body);
    res.set({
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*'
    });
    bodyStream.pipe(res);
  } catch (err) {
    console.error(`Proxy Error [${imageUrl}]:`, err);
    const statusCode = err.message.includes('aborted') ? 504 : 500;
    res.status(statusCode).send(err.message);
  } finally {
    clearTimeout(timeout);
  }
});

app.get('/search', async (req, res) => { 
  const query = req.query.q;
  const pageNumber = parseInt(req.query.page) || 1;
  if (!query) return res.status(400).json({ error: 'Query required' });

  const cacheKey = `search-${query}-${pageNumber}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  let browser, page;
  try {
    browser = await getBrowser();
    page = await createPage(browser);
    
    await page.goto(`https://doujindesu.tv/page/${pageNumber}/?s=${encodeURIComponent(query)}`, {
      waitUntil: 'domcontentloaded',
      timeout: DEFAULT_TIMEOUT
    });

    // Scrape search results
    const results = await page.$$eval('.entries article', articles => 
      articles.map(article => ({
        title: article.querySelector('.metadata .title span')?.textContent.trim() || "No title",
        link: article.querySelector('a')?.href,
        thumbnail: article.querySelector('img')?.src,
        score: article.querySelector('.metadata .score')?.textContent.trim() || "N/A",
        status: article.querySelector('.metadata .status')?.textContent.trim() || "Unknown"
      }))
    );

    // Scrape total pages
    const totalPages = await page.$$eval('nav.pagination ul li a strong', items => {
      let max = 1;
      items.forEach(el => {
        const num = parseInt(el.textContent);
        if (!isNaN(num) && num > max) max = num;
      });
      return max;
    });

    const response = {
      success: true,
      page: pageNumber,
      totalPages,
      results,
      cached: false
    };

    cache.set(cacheKey, response);
    res.set('Cache-Control', 'public, max-age=600');
    res.json(response);

  } catch (err) {
    console.error('Error in /search:', err);
    res.status(500).json({ 
      error: err.message,
      code: err.code 
    });
  } finally {
    if (page) await page.close();
    if (browser) releaseBrowser(browser);
  }
});

app.get('/detail', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Parameter url wajib' });

  const cacheKey = `detail-${url}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  let browser, page;
  try {
    browser = await getBrowser();
    page = await createPage(browser);
    
    const fullUrl = url.startsWith('http') ? url : `https://doujindesu.tv/manga/${url}`;
    await page.goto(fullUrl, { 
      waitUntil: 'domcontentloaded', 
      timeout: DEFAULT_TIMEOUT 
    });

    await page.waitForSelector('.bxcl', { timeout: DEFAULT_TIMEOUT });

    // Streamline data extraction by running both operations in parallel
    const [chapters, detail] = await Promise.all([
      page.evaluate(() => {
        return Array.from(document.querySelectorAll('.bxcl ul li')).map(chapter => ({
          chapterTitle: chapter.querySelector('.epsright .eps a')?.innerText.trim(),
          chapterLink: chapter.querySelector('.epsright .eps a')?.getAttribute('href'),
          chapterName: chapter.querySelector('.epsleft .lchx a')?.innerText.trim(),
          chapterDate: chapter.querySelector('.epsleft .date')?.innerText.trim()
        }));
      }),
      page.evaluate(() => ({
        title: document.querySelector('h1.title')?.textContent,
        thumbnail: document.querySelector('.thumbnail img')?.src,
        rating: document.querySelector('.rating-prc')?.textContent,
        genres: Array.from(document.querySelectorAll('.tags a')).map(t => t.textContent)
      }))
    ]);

    const response = {
      success: true,
      detail: {
        ...detail,
        chapters
      },
      cached: false
    };

    cache.set(cacheKey, response);
    res.set('Cache-Control', 'public, max-age=600');
    res.json(response);

  } catch (err) {
    console.error('Error in /detail:', err);
    res.status(500).json({ 
      error: err.message,
      code: err.code 
    });
  } finally {
    if (page) await page.close();
    if (browser) releaseBrowser(browser);
  }
});

// Track active auto-thumbnail operations
let autoThumbnailInProgress = false;
let currentThumbnailOperation = null;

app.get('/auto-thumbnail', async (req, res) => {
  const query = req.query.q;
  const page = parseInt(req.query.page) || 1; // Single page parameter
  const maxPages = parseInt(req.query.maxPages) || 1; // Maximum pages parameter
  const thumbnailResults = [];
  let currentProcessedPage = 0;
  
  if (!query) {
    return res.status(400).json({ error: 'Query is required' });
  }

  // If there's already an operation in progress, reject new requests
  if (autoThumbnailInProgress) {
    return res.status(429).json({ 
      success: false, 
      error: 'Another auto-thumbnail operation is in progress, please try again later',
      currentOperation: {
        query: currentThumbnailOperation?.query,
        startedAt: currentThumbnailOperation?.startedAt,
        elapsedSeconds: currentThumbnailOperation ? 
          Math.floor((Date.now() - currentThumbnailOperation.startedAt) / 1000) : 0
      }
    });
  }

  // Calculate start and end page based on parameters
  const startPage = page;
  const endPage = Math.max(startPage, Math.min(startPage + maxPages - 1, startPage + 9)); // Limit to reasonable range

  // Set lock
  autoThumbnailInProgress = true;
  currentThumbnailOperation = {
    query,
    startPage,
    endPage,
    startedAt: Date.now()
  };

  // Function to release lock when operation completes
  const releaseLock = () => {
    autoThumbnailInProgress = false;
    currentThumbnailOperation = null;
  };

  try {
    // 1. Set timeout for the entire operation
    const TIMEOUT = req.query.timeout ? parseInt(req.query.timeout) * 1000 : 300000; // Default 5 minutes
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.log(`Auto-thumbnail timeout after ${TIMEOUT/1000} seconds for query "${query}" pages ${startPage}-${endPage}`);
      controller.abort();
    }, TIMEOUT);

    console.log(`Starting auto-thumbnail for query "${query}" on pages ${startPage}-${endPage}`);
    
    // 2. Process each page sequentially
    for (let currentPage = startPage; currentPage <= endPage; currentPage++) {
      currentProcessedPage = currentPage;
      
      if (controller.signal.aborted) {
        console.log('Operation has been aborted, stopping processing');
        throw new Error('Operation aborted');
      }
      
      console.log(`Processing page ${currentPage}/${endPage} for query "${query}"`);
      
      try {
        // Call the search endpoint with the current page
        const searchResponse = await fetch(`http://127.0.0.1:5000/search?q=${encodeURIComponent(query)}&page=${currentPage}`, {
          signal: controller.signal,
          timeout: 5000 // 5 seconds timeout per request
        });
        
        const searchData = await searchResponse.json();
        
        // Extract thumbnails based on the response structure
        let thumbnails = [];
        
        // Handle different possible response structures
        if (searchData && searchData.thumbnail) {
          // Single thumbnail directly in response
          thumbnails.push(searchData.thumbnail);
        } else if (searchData && Array.isArray(searchData.results)) {
          // Results array with thumbnails
          thumbnails = searchData.results
            .filter(item => item && item.thumbnail)
            .map(item => item.thumbnail);
        } else if (Array.isArray(searchData)) {
          // Direct array of results
          thumbnails = searchData
            .filter(item => item && item.thumbnail)
            .map(item => item.thumbnail);
        }
        
        // Skip to next page if no thumbnails found
        if (thumbnails.length === 0) {
          console.log(`No thumbnails found on page ${currentPage}, continuing to next page`);
          continue;
        }
        
        console.log(`Found ${thumbnails.length} thumbnails on page ${currentPage}`);
        
        // Remove duplicate thumbnails
        const uniqueThumbnails = [...new Set(thumbnails)];
        
        // 3. Process thumbnails with concurrency control
        const processThumbnails = async (thumbnails, concurrencyLimit = 3) => {
          const results = [];
          const chunks = [];
          
          // Split thumbnails into chunks according to concurrency limit
          for (let i = 0; i < thumbnails.length; i += concurrencyLimit) {
            chunks.push(thumbnails.slice(i, i + concurrencyLimit));
          }
          
          console.log(`Processing ${thumbnails.length} thumbnails in ${chunks.length} batches`);
          
          // Process each chunk sequentially
          for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
            const chunk = chunks[chunkIndex];
            console.log(`Processing batch ${chunkIndex + 1}/${chunks.length} with ${chunk.length} thumbnails`);
            
            try {
              // Check if operation has been aborted
              if (controller.signal.aborted) {
                console.log('Operation has been aborted, stopping processing');
                throw new Error('Operation aborted');
              }
              
              // Process each thumbnail in the chunk concurrently
              const chunkPromises = chunk.map(async (thumbnailUrl, index) => {
                try {
                  console.log(`Processing thumbnail ${index + 1}/${chunk.length} in batch ${chunkIndex + 1}: ${thumbnailUrl}`);
                  
                  // Use the /get endpoint to process this thumbnail URL with autoClose parameter
                  const getResponse = await fetch(`http://127.0.0.1:5000/get?url=${encodeURIComponent(thumbnailUrl)}&autoClose=true`, {
                    signal: controller.signal,
                    timeout: 10000 // 10 seconds timeout for thumbnail processing
                  });
                  
                  const data = await getResponse.json();
                  
                  if (!data.cdnUrl) {
                    return {
                      originalThumbnail: thumbnailUrl,
                      status: 'failed',
                      reason: 'No CDN URL returned'
                    };
                  }
                  
                  return {
                    page: currentPage,
                    originalThumbnail: thumbnailUrl,
                    cdnUrl: data.cdnUrl,
                    status: 'success'
                  };
                } catch (thumbnailError) {
                  console.error(`Error processing thumbnail ${thumbnailUrl}:`, thumbnailError);
                  return {
                    page: currentPage,
                    originalThumbnail: thumbnailUrl,
                    status: thumbnailError.name === 'AbortError' ? 'aborted' : 'error',
                    reason: thumbnailError.message
                  };
                }
              });
              
              // Wait for all thumbnails in the chunk to be processed
              const chunkResults = await Promise.all(chunkPromises);
              results.push(...chunkResults);
              
            } catch (chunkError) {
              console.error(`Error processing batch ${chunkIndex + 1}:`, chunkError);
              
              // If this is an abort error, stop processing
              if (chunkError.name === 'AbortError' || chunkError.message === 'Operation aborted') {
                throw chunkError; // Re-throw to stop the process
              }
              // For other errors, try to continue to the next batch
            }
          }
          
          return results;
        };
        
        // Process all thumbnails for this page
        const pageThumbnailResults = await processThumbnails(uniqueThumbnails);
        thumbnailResults.push(...pageThumbnailResults);
        
        console.log(`Completed processing page ${currentPage}/${endPage}, found ${pageThumbnailResults.length} thumbnails`);
        
      } catch (pageError) {
        console.error(`Error fetching page ${currentPage}:`, pageError);
        
        // If this is an abort error, stop processing
        if (pageError.name === 'AbortError' || pageError.message === 'Operation aborted') {
          throw pageError; // Re-throw to stop the process
        }
        // For other errors, try to continue to the next page
      }
    }

    // All pages processed
    clearTimeout(timeoutId);
    
    // Release lock before sending response
    releaseLock();
    
    // Calculate stats
    const successCount = thumbnailResults.filter(item => item.status === 'success').length;
    const failedCount = thumbnailResults.filter(item => item.status !== 'success').length;
    
    return res.json({
      success: true,
      query,
      startPage,
      endPage,
      processedPages: currentProcessedPage - startPage + 1,
      totalPages: endPage - startPage + 1,
      stats: {
        total: thumbnailResults.length,
        success: successCount,
        failed: failedCount
      },
      thumbnails: thumbnailResults
    });
    
  } catch (error) {
    console.error('Auto-thumbnail error:', error);
    
    // If operation was aborted, try to send partial results
    if (error.name === 'AbortError' || error.message === 'Operation aborted') {
      // Release lock
      releaseLock();
      
      // Calculate stats for partial results
      const successCount = thumbnailResults.filter(item => item.status === 'success').length;
      const failedCount = thumbnailResults.filter(item => item.status !== 'success').length;
      
      return res.status(202).json({
        success: false,
        query,
        startPage,
        endPage,
        processedPages: currentProcessedPage - startPage + 1,
        totalPages: endPage - startPage + 1,
        error: 'Operation timed out',
        message: 'The operation timed out but partial results are available',
        stats: {
          total: thumbnailResults.length,
          success: successCount,
          failed: failedCount
        },
        thumbnails: thumbnailResults
      });
    }
    
    // Release lock if any error occurs
    releaseLock();
    
    return res.status(500).json({ 
      success: false, 
      query,
      startPage,
      endPage,
      error: error.message || 'Unknown error',
      processedPages: currentProcessedPage - startPage + 1,
      thumbnails: thumbnailResults
    });
  }
});

app.get('/get', async (req, res) => {
  const imageUrl = req.query.url;

  if (!imageUrl) {
    return res.status(400).json({ error: 'Image URL is required' });
  }

  let browser;
  try {
    const parsedUrl = new URL(imageUrl);
    const fileName = path.basename(parsedUrl.pathname); // contoh: "45673.jpg"
    const uploadPath = `IMAGES/${fileName}`; // ✅ folder target di R2

    // Cek database
    const existing = await sql`
      SELECT cdn_url FROM thumbnails WHERE filename = ${fileName}
    `;

    if (existing.length > 0) {
      return res.json({ cdnUrl: existing[0].cdn_url });
    }

    // Bypass proteksi gambar
    browser = await getBrowser();
    const page = await createPage(browser);
    
    await page.goto(imageUrl, { 
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    const finalUrl = page.url();
    const imageResponse = await page.goto(finalUrl);
    const imageBuffer = await imageResponse.buffer();

    // ✅ Upload ke R2 di folder 'uploads/IMAGES/'
    const cdnUrl = await uploadToR2(imageBuffer, uploadPath);
    await sql`
    INSERT INTO thumbnails (filename, source_url, cdn_url)
    VALUES (${fileName}, ${imageUrl}, ${cdnUrl})
    ON CONFLICT (filename) DO UPDATE SET
      cdn_url = EXCLUDED.cdn_url
  `;
  
    return res.json({ cdnUrl });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ 
      error: 'Gagal memproses gambar',
      details: error.message
    });
  } finally {
    if (browser) {
      await releaseBrowser(browser);
    }
  }
});


// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    browserPool: browserPool.length
  });
});

// Rate limiting middleware for better protection
const rateLimit = {};
app.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  
  if (!rateLimit[ip]) {
    rateLimit[ip] = { count: 1, resetTime: now + 60000 }; // 1 minute window
  } else if (now > rateLimit[ip].resetTime) {
    rateLimit[ip] = { count: 1, resetTime: now + 60000 };
  } else {
    rateLimit[ip].count++;
    if (rateLimit[ip].count > 60) { // 60 requests per minute
      return res.status(429).json({ error: 'Too many requests' });
    }
  }
  
  next();
});

// Clean up rate limiting data periodically
setInterval(() => {
  const now = Date.now();
  Object.keys(rateLimit).forEach(ip => {
    if (now > rateLimit[ip].resetTime) {
      delete rateLimit[ip];
    }
  });
}, 60000); // Every minute

// Initialize
(async () => {
  await initBrowserPool();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server ready at http://0.0.0.0:${PORT}`);
  });
})();

// Cleanup
process.on('exit', async () => {
  console.log('Shutting down browser pool...');
  await Promise.all(browserPool.map(b => b.close()));
});

// Handle unexpected errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
});