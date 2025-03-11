// ==UserScript==
// @name         YouTube Master Playlist Navigator
// @namespace    http://tampermonkey.net/
// @version      0.17.1
// @description  Top bar for managing master playlists and navigating videos from sub–playlists on YouTube.
// @author       https://github.com/hjjg200/youtube-playlist-navbar
// @match        https://*.youtube.com/*
// @run-at       document-start
// @grant        none
// @require      https://cdnjs.cloudflare.com/ajax/libs/pako/2.0.4/pako.min.js
// ==/UserScript==

(function () {
  'use strict';

  // --------- CONFIGURATION & CONSTANTS ----------
  let API_KEY;
  const API_BASE = "https://www.googleapis.com/youtube/v3";
  const CACHE_EXPIRY = 6 * 60 * 60 * 1000; // 6 hours in milliseconds
  const CACHE_LARGE_EXPIRY = 24 * 60 * 60 * 1000; // 1 day for playlists with LARGE_SIZE+ videos
  const LARGE_SIZE = 1000; // 1000+ videos are considered large
  const MASTER_PLAYLIST_KEY = 'tm_master_playlists'; // stored master playlists

  function ensureAPIKey() {
    API_KEY = localStorage.getItem("tm_yt_api_key");
    while (!API_KEY) {
      API_KEY = prompt("API KEY\nhttps://developers.google.com/youtube/v3");
    }
    localStorage.setItem("tm_yt_api_key", API_KEY);
  }

  function revokeAPIKey() {
    localStorage.removeItem("tm_yt_api_key");
  }

  class Mutex {
    constructor() {
      this._queue = [];
      this._isLocked = false;
    }

    async lock() {
      const ticket = new Promise(resolve => this._queue.push(resolve));
      if (!this._isLocked) {
        this._dispatchNext();
      }
      await ticket;
    }

    unlock() {
      if (!this._isLocked) {
        throw new Error("Cannot unlock an unlocked mutex.");
      }
      this._dispatchNext();
    }

    _dispatchNext() {
      if (this._queue.length > 0) {
        this._isLocked = true;
        const nextResolve = this._queue.shift();
        nextResolve(); // Resume the next waiting task
      } else {
        this._isLocked = false;
      }
    }
  }
  const apiMu = new Mutex();
  async function apiFetch(url, options = {}) {
    apiMu.lock();
    try {
      return await fetch(url, options);
    } finally {
      apiMu.unlock();
    }
  }

  async function processAPIResponse(response) {

    const obj = await response.json();
    if (response.ok) return obj;

    const error = obj?.error;

    if (!error) logError("No connection to youtube API", { showAlert: true, throwError: true });

    // Check errors
    if (error.details?.some(a => a.reason === "API_KEY_INVALID")) {
      revokeAPIKey();
      logError("API Error: Inavlid API key", { showAlert: true, throwError: true });
    }

    logError(`API Error: ${error.message}`, { showAlert: true, throwError: true });

  }

  const deprecatedSpan = document.createElement("span");
  deprecatedSpan.title = "This script is deprecated!";
  deprecatedSpan.textContent = "⚠️";
  deprecatedSpan.style.display = "none";
  function markDeprecated() {
    deprecatedSpan.style.display = "";
  }

  // --------- UTILITY FUNCTIONS: GZIP Compression ----------
  function compressData(data) {
    const json = JSON.stringify(data);
    const compressed = pako.gzip(json, { level: 9 });
    let binary = '';
    const len = compressed.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(compressed[i]);
    }
    return btoa(binary);
  }

  function decompressData(base64) {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const decompressed = pako.ungzip(bytes, { to: 'string' });
    return JSON.parse(decompressed);
  }

  function isBase64(str) {
    if (typeof str !== 'string') return false;

    // Remove any line breaks for validation
    const cleanedStr = str.replace(/\s+/g, '');

    // Base64 length must be a multiple of 4
    if (!cleanedStr || cleanedStr.length % 4 !== 0) return false;

    // Regular expression for Base64
    const base64Regex = /^[A-Za-z0-9+/]+={0,2}$/;

    if (!base64Regex.test(cleanedStr)) return false;

    try {
      // Try decoding and re-encoding to ensure it's valid Base64
      return btoa(atob(cleanedStr)) === cleanedStr;
    } catch (err) {
      return false;
    }
  }

  function getClosestDivIndex(targetDiv, divs) {
    const targetRect = targetDiv.getBoundingClientRect();
    const targetCenter = targetRect.top + targetRect.height / 2;

    return divs.reduce((closest, current, index) => {
      const currentCenter = current.getBoundingClientRect().top + current.getBoundingClientRect().height / 2;
      const closestCenter = divs[closest].getBoundingClientRect().top + divs[closest].getBoundingClientRect().height / 2;

      return Math.abs(currentCenter - targetCenter) < Math.abs(closestCenter - targetCenter)
        ? index
        : closest;
    }, 0); // Initial index is 0
  }

  function getCurrentFormattedTime() {
    const now = new Date();
    const pad = (n) => n.toString().padStart(2, '0');

    const year = now.getFullYear().toString().slice(-2); // Last two digits of the year
    const month = pad(now.getMonth() + 1); // Months are zero-based
    const day = pad(now.getDate());
    const hours = pad(now.getHours());
    const minutes = pad(now.getMinutes());
    const seconds = pad(now.getSeconds());

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }

  const logInfoDiv = document.createElement("div");
  function logInfo(msg) {
    if (msg) {
      logInfoDiv.style.display = "";
      logInfoDiv.textContent = msg;
    } else {
      logInfoDiv.style.display = "none";
    }
  }

  function logError(msg, { showAlert = false, throwError = false, appendToLog = true } = {}) {
    if (appendToLog) {
      let l = localStorage.getItem("tm_logs") || "";
      l = l.split("\n");
      l = l.slice(-500);
      l.push(`[${getCurrentFormattedTime()}] ${msg}`);
      l = l.join("\n");
      localStorage.setItem("tm_logs", l);
    }

    console.error(msg);
    if (showAlert) alert(msg);
    if (throwError) throw new Error(msg);
    
    return msg;
  }

  function debounce(func, delay) {
    let timeout;

    return function (...args) {
      clearTimeout(timeout); // Clear the previous timer
      timeout = setTimeout(() => {
        func.apply(this, args); // Call the function after the delay
      }, delay);
    };
  }


  function throttle(func, limit) {
    let lastCall = 0;

    return function (...args) {
      const now = Date.now();
      if (now - lastCall >= limit) {
        lastCall = now;
        func.apply(this, args);
      }
    };
  }

  function chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }

  function listFunctions(obj) { // enumerable
    const funcs = [];
    for (let key in obj) {
      if (typeof obj[key] === 'function') {
        funcs.push({ key, f: obj[key] });
      }
    }
    return funcs;
  }

  const trustPolicy = window.trustedTypes?.createPolicy('default', {
    createHTML: (input) => input
  });

  (() => {
    /**
     * Encodes an integer (which may be negative) as a custom varint.
     * The first byte: bit7 = continuation, bit6 = sign, bits0-5 = low 6 bits of abs value.
     * Subsequent bytes: 7 bits per byte with MSB as continuation flag.
     * @param {number} num - The integer to encode.
     * @returns {number[]} - The encoded varint as an array of bytes.
     */
    function encodeSignedVarint(num) {
      const bytes = [];
      const sign = num < 0 ? 1 : 0;
      let absNum = Math.abs(num);
      
      // Get the lower 6 bits of the number.
      let firstData = absNum & 0x3F; // 0x3F is 63 (6 bits)
      absNum >>>= 6;
      
      // Build first byte: set lower 6 bits and the sign bit.
      let firstByte = firstData | (sign << 6);
      if (absNum > 0) {
        firstByte |= 0x80; // Set continuation flag if more bytes follow.
      }
      bytes.push(firstByte);
      
      // Encode remaining bits in 7-bit groups.
      while (absNum > 0) {
        let byte = absNum & 0x7F; // 7 bits of data.
        absNum >>>= 7;
        if (absNum > 0) {
          byte |= 0x80; // Set continuation flag.
        }
        bytes.push(byte);
      }
      
      return bytes;
    }

    /**
     * Decodes our custom signed varint from an array of bytes.
     * @param {number[]} bytes - The byte array.
     * @returns {number} - The decoded integer.
     */
    function decodeSignedVarint(bytes) {
      if (bytes.length === 0) throw new Error("Empty byte array");
      
      const firstByte = bytes[0];
      const sign = (firstByte >> 6) & 0x01; // Extract sign bit.
      let result = firstByte & 0x3F;         // Lower 6 bits of data.
      let shift = 6;
      let i = 1;
      
      while (i < bytes.length) {
        const byte = bytes[i];
        result |= (byte & 0x7F) << shift;
        shift += 7;
        i++;
        if ((byte & 0x80) === 0) break;
      }
      
      return sign ? -result : result;
    }

    /**
     * Converts an array of bytes to a Base64 string.
     * @param {number[]} bytes - Array of bytes.
     * @returns {string} - Base64 string (with standard padding).
     */
    function byteArrayToBase64(bytes) {
      const binary = String.fromCharCode(...bytes);
      return btoa(binary);
    }

    /**
     * Removes trailing '=' characters (padding) from a Base64 string.
     * @param {string} base64Str - Base64 string with padding.
     * @returns {string} - Base64 string without trailing '='.
     */
    function removePadding(base64Str) {
      return base64Str.replace(/=+$/, '');
    }

    /**
     * Adds '=' padding to a Base64 string until its length is a multiple of 4.
     * @param {string} base64Str - Base64 string without padding.
     * @returns {string} - Padded Base64 string.
     */
    function addPadding(base64Str) {
      const remainder = base64Str.length % 4;
      if (remainder === 0) return base64Str;
      return base64Str + '='.repeat(4 - remainder);
    }

    /**
     * Converts a Base64 string (without padding) to an array of bytes.
     * @param {string} base64Str - Base64 string without padding.
     * @returns {number[]} - Array of bytes.
     */
    function base64ToByteArray(base64Str) {
      const padded = addPadding(base64Str);
      const binary = atob(padded);
      const bytes = [];
      for (let i = 0; i < binary.length; i++) {
        bytes.push(binary.charCodeAt(i));
      }
      return bytes;
    }
    
    /**
     * Encodes an integer (possibly negative) as a custom varint and returns a Base64 string without padding.
     * @param {number} num - The integer to encode.
     * @returns {string} - Base64 representation (no trailing '=' characters).
     */
    window.encodeVarintB64 = function(num) {
    //function encodeSignedVarintToBase64(num) {
      const bytes = encodeSignedVarint(num);
      return removePadding(byteArrayToBase64(bytes));
    }

    /**
     * Decodes a Base64 string (without padding) into an integer using our custom varint decoding.
     * @param {string} base64Str - Base64 encoded varint (no padding).
     * @returns {number} - The decoded integer.
     */
    window.decodeVarintB64 = function(base64Str) {
    //function decodeSignedVarintFromBase64(base64Str) {
      const bytes = base64ToByteArray(base64Str);
      return decodeSignedVarint(bytes);
    }
  })();

  function shortenTime(time, zero, divider) {
    time = time - zero;
    time = time / divider;
    return Math.round(time);
  }

  function unshortenTime(short, zero, divider) {
    short = short * divider;
    short += zero;
    return short;
  }

  // --------- TRAP _yt_player ---------
  let changeAppVideo = null;
  const TrapYTPlayer = (value) => {

    return new Proxy(value, {
      defineProperty: (target, property, descriptor) => {
        (() => {
          if (typeof descriptor.value !== "function") {
            return;
          }

          const original = descriptor.value;
          descriptor.value = function () {

            const ret = original.apply(this, arguments);

            if (null === changeAppVideo) {

              for (let r of arguments) {
                if (r?.api?.app) {
                  let fs = listFunctions(r.api.app);
                  fs = fs.filter(a => a.f.length >= 7);

                  // Map { key, f, def }
                  fs = fs.map(a => ({ ...a, def: a.f.toString() }));
                  fs = fs.filter(a => a.def.includes("videoId"));
                  fs = fs.filter(a => a.def.includes("loadPlaylist"));
                  fs = fs.filter(a => a.def.includes("loadVideoByPlayerVars"));
                  if (fs.length !== 1) {
                    markDeprecated();
                  } else {
                    const app = r.api.app;
                    const key = fs[0].key;
                    changeAppVideo = function () {
                      app[key](...arguments);
                    };
                  }
                }
              }

            }

            return ret;

          }

        })();

        return Reflect.defineProperty(target, property, descriptor);
      },
    });
  }

  Object.defineProperty(window, "_yt_player", {
    value: TrapYTPlayer(window._yt_player || {}),
  });

  // --------- MASTER PLAYLIST STORAGE ----------
  function getMasterPlaylists() {
    const data = localStorage.getItem(MASTER_PLAYLIST_KEY);
    return data ? JSON.parse(data) : {};
  }

  function saveMasterPlaylists(playlists) {
    localStorage.setItem(MASTER_PLAYLIST_KEY, JSON.stringify(playlists));
  }

  // --------- CACHE FUNCTIONS FOR SUB–PLAYLISTS ----------
  /**
   * Generic helper to retrieve cached data from localStorage.
   * It expects the stored value to have a compressedData and timestamp.
   * If the decompressed array length is greater than 1000, it uses largeExpiry.
   *
   * @param {string} key - The localStorage key.
   * @returns {any|null} - The decompressed cached data or null if expired/missing.
   */
  function getCachedData(key) {
    const data = localStorage.getItem(key);
    if (data) {
      try {
        const obj = JSON.parse(data);
        const cachedData = decompressData(obj.compressedData);
        return [cachedData, obj.timestamp];
      } catch (e) {
        logError(`Error decompressing cache for key: ${key} e: ${e}`);
      }
    }
    return [null, null];
  }

  /**
   * Generic helper to save data to localStorage with compression.
   *
   * @param {string} key - The localStorage key.
   * @param {any} dataToCache - The data to compress and store.
   */
  function saveCachedData(key, dataToCache) {
    const compressedData = compressData(dataToCache);
    // Spread out cache modified time to avoid simultaneous cache update -10 to +10 minutes
    const salt = Math.floor(20 * 60 * 1000 * Math.random() - 10 * 60 * 1000);
    const obj = { compressedData, timestamp: Date.now() + salt };
    localStorage.setItem(key, JSON.stringify(obj));
  }

  // Now, we can implement the original functions using the helpers:
  const beingCachedKeyMap = {};
  async function getCachedVideoInfos(id, type) {
    let cacheKey, fetcher, saver;
    if (type === "playlist") {
      cacheKey = 'tm_sub_playlist_' + id;
      fetcher = fetchSubPlaylistVideoInfos;
      saver = saveCachedSubPlaylist;
    } else if (type === "channel") {
      cacheKey = 'tm_sub_playlist_channel_' + id;
      fetcher = fetchChannelVideoInfos;
      saver = saveCachedChannelPlaylist;
    } else {
      throw new Error("Unexpected behavior");
    }

    const [cachedMini, timestamp] = getCachedData(cacheKey);
    const cached = cachedMini ? unminifyVideoInfos(cachedMini) : null;
    let stale = null;

    if (!cached) {

      // Null means no data at all
      for (let i = 0; i < 5; i++) {
        const videoInfos = await fetcher(id);
        if (!videoInfos) continue;

        saver(id, videoInfos);
        return videoInfos;
      }
      logError(`Failed to fetch video ids for ${id} after 5 attempts`, { throwError: true });

    } else {
      
      // Check if the cache is stale
      let effectiveExpiry = CACHE_EXPIRY;
      if (cached.length > LARGE_SIZE) {
        effectiveExpiry = CACHE_LARGE_EXPIRY;
      }
      stale = Date.now() - timestamp > effectiveExpiry;

    }

    // If cache is stale
    if (stale === true) {
      (async () => {
        // This lock mechanism assumes there is only one tab actively running this script
        if (beingCachedKeyMap[cacheKey]) return;
        beingCachedKeyMap[cacheKey] = true;

        let success = false;
        for (let i = 0; i < 5; i++) {
          const videoInfos = await fetcher(id);
          if (!videoInfos) continue;

          saver(id, videoInfos);
          success = true;
          break;
        }
        if (!success) {
          logError(`Failed to update video ids for ${id} after 5 attempts`);
        }

        beingCachedKeyMap[cacheKey] = false;
      })();
    }

    return cached;
  }

  async function getCachedSubPlaylist(playlistId) {
    return await getCachedVideoInfos(playlistId, "playlist");
  }

  function saveCachedSubPlaylist(playlistId, videoInfos) {
    const key = 'tm_sub_playlist_' + playlistId;
    const mini = minifyVideoInfos(videoInfos);
    saveCachedData(key, mini);
  }

  async function getCachedChannelPlaylist(channelId) {
    return await getCachedVideoInfos(channelId, "channel");
  }

  function saveCachedChannelPlaylist(channelId, videoInfos) {
    const key = 'tm_sub_playlist_channel_' + channelId;
    const mini = minifyVideoInfos(videoInfos);
    saveCachedData(key, mini);
  }

  const minifyVideoInfosVersion = "v3.1";
  const minifyVideoInfosMapping = [
    {
      key: 'id',
      parser: null,
      stringifier: null,
      apiGetter: video => video.id
    },
    {
      key: 'publishedAt',
      parser: a => unshortenTime(decodeVarintB64(a), 1673_136_000_000, 1000 * 60),
      stringifier: v => encodeVarintB64(shortenTime(v, 1673_136_000_000, 1000 * 60)),
      apiGetter: video => (new Date(video.snippet.publishedAt)).getTime()
    }
  ];
  const minifyVideoInfosHeader = minifyVideoInfosMapping.map(a => a.key).join("\t") + "\t" + minifyVideoInfosVersion;

  function minifyVideoInfos(videoInfos) {

    const header = minifyVideoInfosHeader;
    
    let mini = [header];
    mini.push(...videoInfos.map(a => {
      const items = [];
      for (let i in minifyVideoInfosMapping) {
        const m = minifyVideoInfosMapping[i];
        let value = a[m.key];
        if (value === undefined) {
          logError(`${m.key} is not found in ${JSON.stringify(a)}`, {throwError: true} );
        }

        if (m.stringifier) {
          value = m.stringifier(value);
        }
        items.push(value);
      }
      return items.join("\t");
    }));
    mini = mini.join("\n");
    return mini;

  }

  function unminifyVideoInfos(mini) {
    if (typeof mini !== "string") {
      logError("The given minified video infos is not string");
      return null;
    }

    let videoInfos = mini.split("\n");
    const expectedHeader = minifyVideoInfosHeader;
    if (videoInfos[0] !== expectedHeader) {
      logError(`The given minified video infos do not have the right header got: "${videoInfos[0]}" expected: "${expectedHeader}"`);
      return null;
    }

    // Slice
    videoInfos = videoInfos.slice(1);
    videoInfos = videoInfos.map(a => a.split("\t"));

    if (videoInfos.some(a => a.length !== minifyVideoInfosMapping.length)) {
      logError("The given minified video infos have some entries whose length does not match");
      return null;
    }

    return videoInfos.map(a => {
      const ret = {};
      for (let i in minifyVideoInfosMapping) {
        const m = minifyVideoInfosMapping[i];
        const value = a[i];
        ret[m.key] = m.parser ? m.parser(value) : value;
      }
      return ret;
    });

  }


  // --------- YOUTUBE API FETCH FUNCTIONS ----------

  /**
   * Fetches all videos from a given playlist (via playlistItems API), then
   * gets detailed information via the Videos API. It filters out videos
   * that are currently live or upcoming (i.e. snippet.liveBroadcastContent is "live" or "upcoming"),
   * returning only completed live videos and regular uploads.
   *
   * @param {string} playlistId - The ID of the playlist.
   * @returns {Promise<string[]>} - Array of video IDs sorted by published date (latest first).
   */
  async function fetchSubPlaylistVideoInfos(playlistId) {
    const maxResults = 50;
    let allItems = [];
    let nextPageToken = '';
    ensureAPIKey();

    const now = Date.now();

    /*
    221 videos
     1.975 Playlistitem
     3.42 getVideosDetails
    **/

    // 1. Fetch all items from the playlist (handle pagination)
    logInfo(`Fetching videos for ${playlistId}...`);
    try {
      do {
        const params = new URLSearchParams({
          part: 'snippet',
          playlistId: playlistId,
          maxResults: maxResults,
          key: API_KEY,
          // Note: The "order" parameter is not supported for playlistItems.
        });
        if (nextPageToken) {
          params.set('pageToken', nextPageToken);
        }
        const url = `${API_BASE}/playlistItems?${params.toString()}`;
        const response = await apiFetch(url);
        const data = await processAPIResponse(response);
        allItems = allItems.concat(data.items);
        nextPageToken = data.nextPageToken || '';
      } while (nextPageToken);
    } catch (error) {
      logError(`Error fetching playlist items: ${error}`);
      return;
    }

    logInfo(`Fetched ${allItems.length} videos for ${playlistId}`);
    console.warn(`${(Date.now() - now) / 1000}s playlistItems ${allItems.length} videos`);

    // Extract video IDs into an array
    const videoIdArray = allItems
      .map(item => item?.snippet?.resourceId?.videoId)
      .filter(Boolean);

    if (!videoIdArray.length) {
      logError(`No video found for ${playlistId}. This is an error unless there really is no videos`,
        { showAlert: true }
      )
      return;
    }

    logInfo(`Getting details of videos for ${playlistId}...`);
    let videos;
    try {
      videos = await getVideosDetails(videoIdArray);
    } catch (error) {
      logError(`Error fetching video details: ${error}`);
      return;
    }
    console.warn(`${(Date.now() - now) / 1000}s getVideosDetails ${videos.length} videos`);

    // 4. Filter out videos that are currently live or upcoming.
    // This ensures we include regular uploads and completed live streams.
    const filtered = videos.filter(video => {
      const broadcastStatus = video.snippet.liveBroadcastContent;
      return broadcastStatus === 'none'; // "none" means it's neither live nor upcoming
    });

    const videoInfos = filtered.map(video => {
      const ret = {};
      for (let i in minifyVideoInfosMapping) {
        const m = minifyVideoInfosMapping[i];
        ret[m.key] = m.apiGetter(video);
      }
      return ret;
    });
    // 5. Sort videos by published date (latest first)
    videoInfos.sort((a, b) => b.publishedAt - a.publishedAt);

    logInfo(null);

    // 6. Return
    return videoInfos;
  }

  /**
   * Fetches detailed video information in batches if needed.
   * @param {string[]} videoIdArray - Array of video IDs.
   * @param {string} baseUrl - Base URL for the YouTube API.
   * @returns {Promise<Object[]>} - Array of video objects.
   */
  async function getVideosDetails(videoIdArray) {
    ensureAPIKey();
    const chunked = chunkArray(videoIdArray, 50); // YouTube API supports max 50 ids per request.
    let allDetails = [];

    for (const chunk of chunked) {
      const ids = chunk.join(',');
      const url = new URL(`${API_BASE}/videos`);
      url.searchParams.set('part', 'snippet,contentDetails,statistics,liveStreamingDetails');
      url.searchParams.set('id', ids);
      url.searchParams.set('key', API_KEY);

      const response = await apiFetch(url.toString());
      const data = await processAPIResponse(response);
      allDetails = allDetails.concat(data.items);
    }

    return allDetails;
  }


  // For channel-based sub–playlists: get the channel's uploads playlist and fetch its videos.
  async function getUploadsPlaylistId(channelId) {
    ensureAPIKey();
    const url = `${API_BASE}/channels?part=contentDetails&id=${channelId}&key=${API_KEY}`;
    try {
      const response = await apiFetch(url);
      const data = await processAPIResponse(response);
      if (data.items && data.items.length > 0) {
        let id = data.items[0].contentDetails.relatedPlaylists.uploads;
        return id;
      }
    } catch (e) {
      logError(`Error fetching uploads playlist for channel id: ${channelId} e: ${e}`);
    }
    return null;
  }

  async function fetchChannelVideoInfos(channelId) {
    const uploadsPlaylistId = await getUploadsPlaylistId(channelId);
    if (!uploadsPlaylistId) return;
    return await fetchSubPlaylistVideoInfos(uploadsPlaylistId);
  }

  // Validate a playlist URL by YouTube API (returns "channelTitle - playlist title")
  async function validatePlaylist(playlistId) {
    ensureAPIKey();
    const url = `${API_BASE}/playlists?part=snippet&id=${playlistId}&key=${API_KEY}`;
    try {
      const response = await apiFetch(url);
      const data = await processAPIResponse(response);
      if (data.items && data.items.length > 0) {
        const { title, channelTitle } = data.items[0].snippet;
        return `${channelTitle} - ${title}`;
      }
    } catch (e) {
      logError(`Error validating playlist id: ${playlistId} e: ${e}`);
    }
    return null;
  }

  // Validate a channel URL by YouTube API (returns channel title)
  async function validateChannel(channelId) {
    ensureAPIKey();
    const url = `${API_BASE}/channels?part=snippet&id=${channelId}&key=${API_KEY}`;
    try {
      const response = await apiFetch(url);
      const data = await processAPIResponse(response);
      if (data.items && data.items.length > 0) {
        return data.items[0].snippet.title;
      }
    } catch (e) {
      logError(`Error validating channel id: ${channelId} e: ${e}`);
    }
    return null;
  }

  // Validate a channel handle by YouTube API (returns channel title)
  async function validateChannelHandle(handle) {
    ensureAPIKey();
    const url = `${API_BASE}/channels?part=snippet&forHandle=${handle}&key=${API_KEY}`;
    try {
      const response = await apiFetch(url);
      const data = await processAPIResponse(response);
      if (data.items && data.items.length > 0) {
        return [data.items[0].id, data.items[0].snippet.title];
      }
    } catch (e) {
      logError(`Error validating channel id: ${channelId} e: ${e}`);
    }
    return [null, null];
  }

  // Refresh (or fetch) each sub–playlist for a given master playlist
  async function refreshMasterPlaylist(masterPlaylist) {
    for (let sub of masterPlaylist.subPlaylists) {
      if (sub.type === 'channel') {
        await getCachedChannelPlaylist(sub.id);
      } else {
        // type === 'playlist'
        await getCachedSubPlaylist(sub.id);
      }
    }
  }

  // Build a mapping of every video (across all sub–playlists) to its video id
  async function getVideoMapping(masterPlaylist) {
    let mapping = [];

    // Uses Set to eliminate duplicate video keys
    // duplicate video keys cause shuffle malfunction
    const seenVideoIds = new Set();
    for (let sub of masterPlaylist.subPlaylists) {
      let videoInfos;
      if (sub.type === 'channel') {
        videoInfos = await getCachedChannelPlaylist(sub.id);
      } else {
        videoInfos = await getCachedSubPlaylist(sub.id);
      }

      // Add from the oldest video id
      // Video IDs are stored in latest first order to match the original order of how vidoes are
      // sorted in channel playlist, so in order to let the next video in the mapping be a more recent video,
      // you need to invert its order
      for (let i = videoInfos.length - 1; i >= 0; i--) {
        const info = videoInfos[i];
        const vid = info.id;
        if (!seenVideoIds.has(vid)) {
          seenVideoIds.add(vid);
          mapping.push({
            _meta: {
              subPlaylist: {
                id: sub.id,
                videoIndex: i
              }
            },
            id: vid,
            publishedAt: info.publishedAt
          });
        }
      }
    }
    return mapping;
  }

  document.addEventListener("DOMContentLoaded", () => {

    // --------- GLOBAL STATE ----------
    let currentMasterId = null;

    // --------- CREATE TOP BAR UI ----------
    const wrapperDiv = document.createElement("div");
    wrapperDiv.style.cssText = `
      width: 100%;
      background: rgba(0, 0, 0, 0.2);
      text-align: center;
      padding: 0.5rem;
      position: fixed;
      top: 0;
      left: 0;
      z-index: 1000000;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.2s ease-out;
      display: flex;
      justify-content: center;
    `;
    document.body.appendChild(wrapperDiv);

    // Show top bar when mouse is near the top of the page
    const debouncedOpacity = debounce(() => {
      wrapperDiv.style.opacity = 0;
    }, 3000);
    wrapperDiv.addEventListener('mousemove', (e) => {
      wrapperDiv.style.opacity = '1';
      debouncedOpacity();
    });

    // Button style (applied to buttons and the select)
    const btnStyle = `
      background: #fff3;
      color: white;
      padding: 0.4rem 0.8rem;
      font-size: 1rem;
      font-family: Arial, sans-serif;
      border: none;
      border-radius: 0.5rem;
      cursor: pointer;
      transition: background 0.3s ease-in-out;
      pointer-events: all;
      margin-right: .25rem;
    `;

    const spanStyle = `
      color: white;
      margin-right: 0.25rem;
      opacity: 0.8;
      transform: translateY(1.2rem);
      line-height: 0;
    `;

    // Deprecation
    deprecatedSpan.style.cssText = deprecatedSpan.style.cssText + `
      margin-right: 0.5rem;
      transform: translateY(1rem);
      line-height: 0;
      pointer-events: all;
      user-select: none;
      font-size: 1.5rem;
    `;
    wrapperDiv.appendChild(deprecatedSpan);

    // Enabled check
    const enabeldSpan = document.createElement("span");
    enabeldSpan.textContent = "Enabled";
    enabeldSpan.style.cssText = spanStyle;
    wrapperDiv.appendChild(enabeldSpan);
    const enabeldCheck = document.createElement("input");
    enabeldCheck.type = "checkbox";
    enabeldCheck.style.pointerEvents = 'all';
    wrapperDiv.appendChild(enabeldCheck);
    const sessionEnabled = sessionStorage.getItem("tm_session_enabled");
    if (sessionEnabled)
      enabeldCheck.checked = "true" == sessionEnabled;
    enabeldCheck.addEventListener("change", () => {
      sessionStorage.setItem("tm_session_enabled", enabeldCheck.checked);
    });
    const manualEnable = () => {
      enabeldCheck.checked = true;
      enabeldCheck.dispatchEvent(new Event("change"));
    };

    // Shuffle check
    const shuffleSpan = document.createElement("span");
    shuffleSpan.textContent = "Shuffle";
    shuffleSpan.style.cssText = spanStyle;
    wrapperDiv.appendChild(shuffleSpan);
    const shuffleCheck = document.createElement("input");
    shuffleCheck.type = "checkbox";
    shuffleCheck.style.cssText = `
      pointer-events: all;
      margin-right: 1rem;
    `;
    shuffleCheck.checked = true;
    wrapperDiv.appendChild(shuffleCheck);
    const sessionShuffle = sessionStorage.getItem("tm_session_shuffle");
    if (sessionShuffle)
      shuffleCheck.checked = "true" == sessionShuffle;
    shuffleCheck.addEventListener("change", () => {
      sessionStorage.setItem("tm_session_shuffle", shuffleCheck.checked);
    });

    // Create select element for "Master Playlists"
    const masterSelect = document.createElement("select");
    // Override text color to black so options are readable on white background
    masterSelect.style.cssText = btnStyle;
    wrapperDiv.appendChild(masterSelect);

    // Create select element for "Master Playlists"
    const seedInput = document.createElement("input");
    seedInput.type = "text";
    seedInput.placeholder = "seed";
    seedInput.style.cssText = btnStyle + "width: 10rem;";
    wrapperDiv.appendChild(seedInput);
    seedInput.addEventListener("change", () => {
      manualEnable();
      localStorage.setItem('tm_current_seed', seedInput.value);
    });
    const savedSeed = localStorage.getItem('tm_current_seed');
    if (savedSeed) seedInput.value = savedSeed;

    // Populate the masterSelect from localStorage data
    function populateMasterSelect() {
      masterSelect.innerHTML = trustPolicy.createHTML('');
      const masterPlaylists = getMasterPlaylists();
      for (let id in masterPlaylists) {
        const option = document.createElement("option");
        option.value = id;
        option.textContent = masterPlaylists[id].name;
        option.style.color = "black";
        masterSelect.appendChild(option);
      }
    }
    populateMasterSelect();
    if (masterSelect.value) currentMasterId = masterSelect.value;

    // Retrieve current master id from localStorage (if set) and update masterSelect
    const storedMasterId = sessionStorage.getItem('tm_current_master_id') || localStorage.getItem('tm_current_master_id');
    if (storedMasterId) {
      currentMasterId = storedMasterId;
      masterSelect.value = storedMasterId;
    }

    // "New" button
    const newButton = document.createElement("button");
    newButton.textContent = "New";
    newButton.type = "button";
    newButton.style.cssText = btnStyle;
    wrapperDiv.appendChild(newButton);

    // "Edit" button
    const editButton = document.createElement("button");
    editButton.textContent = "Edit";
    editButton.type = "button";
    editButton.style.cssText = btnStyle;
    wrapperDiv.appendChild(editButton);

    // "Prev" button
    const prevButton = document.createElement("button");
    prevButton.textContent = "❘◀";
    prevButton.type = "button";
    prevButton.style.cssText = btnStyle + "margin-left: 1.5rem;";
    wrapperDiv.appendChild(prevButton);

    // "Next" button
    const nextButton = document.createElement("button");
    nextButton.textContent = "▶❘";
    nextButton.type = "button";
    nextButton.style.cssText = btnStyle;
    wrapperDiv.appendChild(nextButton);

    // When the master playlist select changes…
    masterSelect.addEventListener('change', async (e) => {
      const selected = masterSelect.value;
      currentMasterId = selected;
      localStorage.setItem('tm_current_master_id', selected);
      sessionStorage.setItem('tm_current_master_id', selected);
      const masterPlaylists = getMasterPlaylists();
      const masterPlaylist = masterPlaylists[currentMasterId];
      if (masterPlaylist) {
        manualEnable();
        await refreshMasterPlaylist(masterPlaylist);
      }
    });

    newButton.addEventListener("click", () => {
      openEditModal(null, true); // open modal to add a new master playlist
      manualEnable();
    });

    // --------- EDIT MODAL (for managing a master playlist) ----------
    async function openEditModal(masterId, isNew) {
      // Create modal overlay
      const modalOverlay = document.createElement("div");
      modalOverlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0,0,0,0.5);
        z-index: 1000000;
        display: flex;
        justify-content: center;
        align-items: center;
      `;
      // Modal content container
      const modalContent = document.createElement("div");
      modalContent.style.cssText = `
        background: #333;
        padding: 2rem;
        border-radius: 0.5rem;
        max-width: 40rem;
        width: 90%;
        color: white;
        font-family: Arial, sans-serif;
        font-size: 1.4rem;
        line-height: 1.2;
        position: relative;
      `;
      modalOverlay.appendChild(modalContent);
      document.body.appendChild(modalOverlay);

      // Get or create the master playlist object
      let masterPlaylists = getMasterPlaylists();
      let masterPlaylist;
      if (masterId && masterPlaylists[masterId]) {
        masterPlaylist = masterPlaylists[masterId];
      } else {
        masterPlaylist = {
          name: "New Master Playlist",
          subPlaylists: []
        };
        masterId = 'mp_' + Date.now();
        masterPlaylists[masterId] = masterPlaylist;
        saveMasterPlaylists(masterPlaylists);
        currentMasterId = masterId;
        populateMasterSelect();
        masterSelect.value = masterId;
      }

      // Title (double–click to edit)
      const titleDiv = document.createElement("div");
      const titleDivStyle = `
        margin-top: 1rem;
        margin-bottom: 1.3rem;
        font-weight: bold;
        font-size: 1.8rem;
        padding: 0;
        border: none;
        appearance: none;
        width: 100%;
        box-sizing: border-box;
        outline: none;
      `;
      titleDiv.textContent = masterPlaylist.name;
      titleDiv.style.cssText = titleDivStyle + 'cursor: pointer;';
      modalContent.appendChild(titleDiv);

      const ondbclick = () => {
        const input = document.createElement("input");
        input.type = "text";
        input.value = masterPlaylist.name;
        input.style.cssText = titleDivStyle;
        modalContent.replaceChild(input, titleDiv);
        input.focus();
        const changeName = () => {
          if (input.value.trim() !== "") {
            masterPlaylist.name = input.value.trim();
            masterPlaylists[masterId] = masterPlaylist;
            saveMasterPlaylists(masterPlaylists);
            titleDiv.textContent = masterPlaylist.name;
            modalContent.replaceChild(titleDiv, input);
            populateMasterSelect();
            masterSelect.value = masterId;
          }
        };
        input.addEventListener('blur', changeName);
        input.addEventListener('keypress', (e) => {
          if (e.key === 'Enter') {
            changeName();
          }
        });
      };
      titleDiv.addEventListener(/*'dblclick'*/'click', ondbclick);
      if (isNew) ondbclick();

      // List of sub–playlists in this master playlist
      const listContainer = document.createElement("div");
      listContainer.style.cssText = `
        overflow-y: auto;
        max-height: 20rem;
        user-select: none;
        cursor: move;
        position: relative;
      `;
      modalContent.appendChild(listContainer);

      // Drag to move list implementation
      let dragHandleLongpress;
      {
        let timeout = null;
        let startX, startY;
        const dragTime = 300;
        const dragDiv = document.createElement("div");
        dragDiv.style.cssText = `
          position: absolute;
          background: #333;
          pointer-events: none;
          opacity: 0.85;
          box-shadow: 0 0 0 0.3rem #333, 0 0 0 0.6rem #eee;
        `;
        let lastClosestIdx = null;
        let newOrder = null;
        let originalDivs = null;
        let originalDraggedIdx = null;
        dragHandleLongpress = (itemDiv, ev) => {
          clearTimeout(timeout);

          startX = ev.clientX;
          startY = ev.clientY;
          const modalRect = modalContent.getBoundingClientRect();
          const rect = itemDiv.getBoundingClientRect();
          dragDiv.style.transform = `translate(
            ${-startX + (rect.left - modalRect.left)}px,
            ${-startY + (rect.top - modalRect.top)}px)`;
          dragDiv.style.top = startY + "px";
          dragDiv.style.left = startX + "px";
          dragDiv.style.width = rect.width + "px";
          timeout = setTimeout(() => {
            dragDiv.innerHTML = itemDiv.outerHTML;
            dragDiv.querySelectorAll("button").forEach(el => el.remove());
            dragDiv.querySelector("& > div").style.margin = "0";
            modalContent.appendChild(dragDiv);
            lastClosestIdx = null;
            originalDivs = Array.from(listContainer.querySelectorAll("& > div"));
            originalDraggedIdx = originalDivs.findIndex(a => a === itemDiv);
            itemDiv.style.opacity = 0;
          }, dragTime);
        };
        modalContent.addEventListener("pointermove", throttle((ev) => {
          if (false === modalContent.contains(dragDiv)) {
            if ((startX && Math.abs(startX - ev.clientX) > 5) ||
              (startY && Math.abs(startY - ev.clientY) > 5)) {
              startX = null;
              startY = null;
              clearTimeout(timeout);
            }
          } else {
            dragDiv.style.top = ev.clientY + "px";
            dragDiv.style.left = ev.clientX + "px";
            const ci = getClosestDivIndex(dragDiv, Array.from(listContainer.querySelectorAll("& > div")));
            if (ci !== lastClosestIdx) {
              lastClosestIdx = ci;
              newOrder = originalDivs.slice();
              const [spliced] = newOrder.splice(originalDraggedIdx, 1);
              newOrder.splice(ci, 0, spliced);
              newOrder.forEach(el => listContainer.appendChild(el));
            }
          }
        }, 10));
        modalContent.addEventListener("pointerup", () => {
          startX = null;
          startY = null;
          clearTimeout(timeout);
          if (modalContent.contains(dragDiv)) {
            modalContent.removeChild(dragDiv);

            const newSubPlaylists = newOrder
              .forEach(itemDiv => itemDiv.style.opacity = "")
              .map(itemDiv => itemDiv.getAttribute("data-id"))
              .map(id => masterPlaylist.subPlaylists.find(sub => sub.id === id))
              .filter(Boolean);
            if (newSubPlaylists.length !== masterPlaylist.subPlaylists.length) {
              logError(`Failed to reorder the playlist`, { showAlert: true, throwError: true });
            }

            masterPlaylist.subPlaylists = newSubPlaylists;
            masterPlaylists[masterId] = masterPlaylist;
            saveMasterPlaylists(masterPlaylists);
          }
        });
      }

      async function refreshSubPlaylistList() {
        listContainer.innerHTML = "";
        for (let sub of masterPlaylist.subPlaylists) {
          const itemDiv = document.createElement("div");
          itemDiv.setAttribute("data-id", sub.id);
          itemDiv.style.marginBottom = "1rem";
          itemDiv.style.display = "flex";
          itemDiv.style.alignItems = "center";
          // Get video count from cache (or placeholder "..." if not available)
          let videoInfos;
          if (sub.type === 'channel') {
            videoInfos = await getCachedChannelPlaylist(sub.id);
          } else {
            videoInfos = await getCachedSubPlaylist(sub.id);
          }
          const itemDivLeft = document.createElement("div");
          const itemDivRight = document.createElement("div");
          itemDiv.appendChild(itemDivLeft);
          itemDiv.appendChild(itemDivRight);
          itemDivLeft.style.flex = "1";
          const count = videoInfos.length;
          const nameDiv = document.createElement("div");
          const nameA = document.createElement("a");
          nameA.textContent = sub.title;
          nameA.style.cssText = `
            color: inherit;
          `;
          nameDiv.appendChild(nameA);
          if (sub.url) {
            nameA.href = sub.url;
          }
          itemDivLeft.appendChild(nameDiv);
          const infoDiv = document.createElement("div");
          infoDiv.textContent = `${sub.id} - ${count} videos`;
          infoDiv.style.fontSize = "1rem";
          infoDiv.style.opacity = "0.6";
          itemDivLeft.appendChild(infoDiv);
          // Delete button for the sub–playlist
          const delBtn = document.createElement("button");
          delBtn.textContent = "×";
          delBtn.style.cssText = btnStyle + `
            line-height: 0;
            border-radius: 0.9rem;
            padding: 0;
            font-size: 1.5rem;
            width: 1.8rem;
            height: 1.8rem;
            box-sizing: border-box;
          `;
          delBtn.addEventListener('click', () => {
            if (confirm(`Remove ${sub.title}?`)) {
              masterPlaylist.subPlaylists = masterPlaylist.subPlaylists.filter(x => x.id !== sub.id);
              masterPlaylists[masterId] = masterPlaylist;
              saveMasterPlaylists(masterPlaylists);
              // Remove cache if no other master playlist uses this sub–playlist
              let stillReferenced = false;
              for (let mpId in masterPlaylists) {
                if (masterPlaylists[mpId].subPlaylists.some(x => x.id === sub.id)) {
                  stillReferenced = true;
                  break;
                }
              }
              if (!stillReferenced) {
                if (sub.type === 'channel') {
                  localStorage.removeItem('tm_sub_playlist_channel_' + sub.id);
                } else {
                  localStorage.removeItem('tm_sub_playlist_' + sub.id);
                }
              }
              refreshSubPlaylistList();
            }
          });
          itemDivRight.appendChild(delBtn);
          listContainer.appendChild(itemDiv);

          // Drag to move implementation
          itemDiv.addEventListener("pointerdown", (ev) => {
            if (ev.target.closest("a") || ev.target.closest("button")) return;

            dragHandleLongpress(itemDiv, ev);
          });
        }
      }

      // Append log info for async log update
      modalContent.appendChild(logInfoDiv);
      logInfoDiv.style.cssText = `
        background: #555;
        font-size: 0.9rem;
        text-align: center;
        padding: 0.5rem 1rem;
        margin-bottom: 0.7rem;
        border-radius: 0.7rem;
      `;
      logInfo(null);
      await refreshSubPlaylistList();
      if (listContainer.scrollHeight > listContainer.clientHeight) {
        listContainer.style.paddingRight = "0.5rem";
      }

      // Input to add a new sub–playlist (accepts URL only)
      const newPlaylistInput = document.createElement("input");
      newPlaylistInput.type = "text";
      newPlaylistInput.placeholder = "Enter URL (playlist or channel)";
      newPlaylistInput.style.cssText = `
        margin-top: 1rem;
        width: 100%;
        outline: none;
        appearance: none;
        border: none;
        padding: .3rem;
        box-sizing: border-box;
      `;
      modalContent.appendChild(newPlaylistInput);

      const urlFormatDiv = document.createElement("div");
      urlFormatDiv.style.cssText = `
        margin-top: .25rem;
        color: #aaa;
        padding-left: 0.3rem;
        font-size: 0.9rem;
      `;
      urlFormatDiv.innerHTML = `
      https://www.youtube.com/playlist?list={playlist_id}<br>
      https://www.youtube.com/@channel/streams<br>
      https://www.youtube.com/@channel/videos<br>
      https://www.youtube.com/@channel
      `;
      modalContent.appendChild(urlFormatDiv);

      // Add subplaylist
      const ADD_SUB_OK = true;
      const ADD_SUB_INVALID_ARG = -1;
      const ADD_SUB_ALREADY_EXISTS = -2;
      async function addSubPlaylist({ id, type, title, url } = {}) {
        if (!id || !type || !title || !url) return ADD_SUB_INVALID_ARG;

        // Push if not found, update if found
        const sub = masterPlaylist.subPlaylists.find(x => x.id === id);
        if (!sub) {
          masterPlaylist.subPlaylists.push({ id, title, type, url });
          masterPlaylists[masterId] = masterPlaylist;
          saveMasterPlaylists(masterPlaylists);
          // No always-renew cache
          if (type === 'channel') {
            await getCachedChannelPlaylist(id);
          } else {
            // type === 'playlist'
            await getCachedSubPlaylist(id);
          }
          await refreshSubPlaylistList();

          return ADD_SUB_OK;
        } else {
          sub.title = title;
          sub.url = url;
          masterPlaylists[masterId] = masterPlaylist;
          saveMasterPlaylists(masterPlaylists);

          // Update listContainer
          const a = listContainer.querySelector(`[data-id="${sub.id}"] a`);
          if (a) {
            a.textContent = sub.title;
            a.href = sub.url;
          }

          return ADD_SUB_ALREADY_EXISTS;
        }
      }

      // Import
      async function tryImport(text) {
        if (!isBase64(text)) return false;

        let imported;
        try {
          imported = decompressData(text);
          imported = JSON.parse(imported);
        } catch {
          alert("Malformed export data");
          return false;
        }

        if (!imported.name || !imported.subPlaylists || !Array.isArray(imported.subPlaylists) || imported.subPlaylists.length === 0) {
          alert("Malformed master playlist data");
          return false;
        }

        // Change name if the current master is empty
        if (masterPlaylist.subPlaylists.length === 0) {
          masterPlaylist.name = imported.name;
          titleDiv.textContent = masterPlaylist.name;
          populateMasterSelect();
        }

        for (const sub of imported.subPlaylists) {
          const res = await addSubPlaylist(sub);
          if (res === ADD_SUB_INVALID_ARG) {
            logError(`Failed to add subplaylist: "${JSON.stringify(sub)}"`, { showAlert: true });
          }
        }

        return true;
      }

      // Drag to import
      modalOverlay.addEventListener("dragover", (event) => event.preventDefault());
      modalOverlay.addEventListener("drop", async (event) => {
        event.preventDefault(); // Prevent default behavior (open in a new tab)
        event.stopPropagation(); // Stop further event bubbling

        const items = event.dataTransfer.items; // Get dropped items

        if (!items) return;

        for (const item of items) {
          if (item.kind === "string") {
            item.getAsString((text) => {
              tryImport(text);
            });
            return;
          } else if (item.kind === "file") {
            const file = item.getAsFile();
            if (file) {
              await tryImport(await file.text());
            }
          }
        }
      });

      let newPlaylistInputRunning = false;
      newPlaylistInput.addEventListener('keypress', async (e) => {
        if (e.key !== 'Enter') return;

        if (newPlaylistInputRunning) {
          alert("Already fetching data...");
          return;
        }
        newPlaylistInputRunning = true;
        try {
          await (async () => {
            const inputValRaw = newPlaylistInput.value.trim();
            if (inputValRaw === "") return;
            let urlObj;
            try {
              urlObj = new URL(inputValRaw);
            } catch (err) {
              if (tryImport(inputValRaw)) {
                newPlaylistInput.value = "";
                return;
              }
              alert("Please enter a valid URL.");
              return;
            }
            let id = null, type = null, title = null;
            // Check for playlist URL first
            if (urlObj.pathname.includes("playlist") && urlObj.searchParams.has("list")) {
              id = urlObj.searchParams.get("list");
              type = 'playlist';
              title = await validatePlaylist(id);
            } else if (urlObj.pathname.includes("/channel/")) {
              // Extract channel id from URL (assuming URL like https://www.youtube.com/channel/CHANNEL_ID)
              const parts = urlObj.pathname.split("/");
              id = parts[parts.indexOf("channel") + 1];
              type = 'channel';
              title = await validateChannel(id);
            } else if (urlObj.pathname.startsWith("/@")) {
              const splits = urlObj.pathname.split("/");
              const handle = splits[1].slice(1);
              [id, title] = await validateChannelHandle(handle);

              // Type
              type = 'channel';
              if (id && title && splits.length >= 3) {
                if (splits[2] === "videos") {
                  type = 'playlist';
                  id = "UULF" + id.slice(2);
                  title = `[Videos] ${title}`;
                } else if (splits[2] === "streams") {
                  type = 'playlist';
                  id = "UULV" + id.slice(2);
                  title = `[Live] ${title}`;
                }
              }

              /** https://stackoverflow.com/questions/71192605/how-do-i-get-youtube-shorts-from-youtube-api-data-v3
                prefix	contents
                UULF	Videos
                UULP	Popular videos
                UULV	Live streams
                UUMF	Members-only videos
                UUMO	Members-only contents (videos, short videos and live streams)
                UUMS	Members-only short videos
                UUMV	Members-only live streams
                UUPS	Popular short videos
                UUPV	Popular live streams
                UUSH	Short videos
              */
            }
            if (!id || !type || !title) {
              alert("Invalid URL or unable to validate the playlist/channel.");
              return;
            }

            // Push if not found, update if found
            const res = await addSubPlaylist({
              id: id,
              title: title,
              type: type,
              url: urlObj.toString()
            });

            if (res === ADD_SUB_ALREADY_EXISTS) {
              alert("Playlist/Channel already added.");
            }

            newPlaylistInput.value = "";
          })();
        } finally {
          newPlaylistInputRunning = false;
        }

      });

      const buttons = document.createElement("div");
      buttons.style.cssText = `
        display: flex;
        margin-top: 1rem;
      `;
      modalContent.appendChild(buttons);

      // Red "Delete Master" button
      const deleteMasterBtn = document.createElement("button");
      deleteMasterBtn.textContent = "Delete Master";
      deleteMasterBtn.style.cssText = btnStyle + "background: red; margin-right: .8rem;";
      deleteMasterBtn.addEventListener('click', () => {
        if (confirm(`Are you sure you want to delete ${masterPlaylist.name}?`)) {
          delete masterPlaylists[masterId];
          saveMasterPlaylists(masterPlaylists);
          if (currentMasterId === masterId) {
            currentMasterId = null;
          }
          populateMasterSelect();
          document.body.removeChild(modalOverlay);
        }
      });
      buttons.appendChild(deleteMasterBtn);

      // "Export" button to close the modal
      const exportBtn = document.createElement("button");
      exportBtn.textContent = "Export";
      exportBtn.style.cssText = btnStyle;
      exportBtn.addEventListener('click', () => {
        let data = JSON.stringify(masterPlaylist, null, 2);
        const blob = new Blob([compressData(data)], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `masterPlaylist-${masterPlaylist.name}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
      });
      buttons.appendChild(exportBtn);

      // Spacer
      const buttonsSpacer = document.createElement("div");
      buttonsSpacer.style.flex = "1";
      buttons.appendChild(buttonsSpacer);

      const aggregateDiv = document.createElement("div");
      aggregateDiv.style.cssText = `
        display: flex;
        align-items: center;
        font-size: 1rem;
        margin-right: 1.2rem;
        user-select: none;
      `;
      const aggregateCheck = document.createElement("input");
      aggregateCheck.type = "checkbox";
      aggregateCheck.addEventListener("change", () => {
        masterPlaylist.aggregate = aggregateCheck.checked;
        masterPlaylists[masterId] = masterPlaylist;
        saveMasterPlaylists(masterPlaylists);
      });
      aggregateCheck.checked = masterPlaylist?.aggregate === true;
      aggregateDiv.appendChild(aggregateCheck);
      const aggregateSpan = document.createElement("span");
      aggregateSpan.textContent = " Aggregate";
      aggregateDiv.appendChild(aggregateSpan);
      buttons.appendChild(aggregateDiv);

      // "Done" button to close the modal
      const doneBtn = document.createElement("button");
      doneBtn.textContent = "Done";
      doneBtn.style.cssText = btnStyle;
      doneBtn.addEventListener('click', () => {
        document.body.removeChild(modalOverlay);
      });
      buttons.appendChild(doneBtn);

    }

    editButton.addEventListener('click', () => {
      if (currentMasterId) {
        openEditModal(currentMasterId, false);
      } else {
        openEditModal(null, true);
      }
    });

    // For shuffling
    function stableSeededSort(ary, seed) {
      return ary
        .map((item) => ({
          item,
          rank: seededHash(item.id, seed)
        }))
        .sort((a, b) => a.rank - b.rank)
        .map(({ item }) => item);
    }

    // A hashing function that produces a consistent pseudo-random rank for a given videoId
    function seededHash(videoId, seed) {
      let hash = 0;
      for (let i = 0; i < videoId.length; i++) {
        hash = (hash * 31 + videoId.charCodeAt(i)) >>> 0; // Simple hash function
      }
      return (Math.sin(seed + hash) * 10000) % 1; // Get a stable random order
    }

    function isPlayerVisible(player) {
      const sz = player.getPlayerSize();
      return sz.width > 0 && sz.height > 0;
    }

    // --------- NEXT BUTTON FUNCTIONALITY ----------
    const YT_PLAYER_STATE_ENDED = 0;
    let nextVideoRedirected = false;
    const nextVideo = async (override = 1) => {

      if (!enabeldCheck.checked) return;

      if (!currentMasterId) {
        alert("No master playlist selected.");
        return;
      }
      const masterPlaylists = getMasterPlaylists();
      const masterPlaylist = masterPlaylists[currentMasterId];
      if (!masterPlaylist || masterPlaylist.subPlaylists.length === 0) {
        alert("Selected master playlist is empty.");
        return;
      }
      const mapping = await getVideoMapping(masterPlaylist);
      if (mapping.length === 0) {
        alert("No videos found in the selected playlists/channels.");
        return;
      }
      
      // Throttle
      if (nextVideoRedirected) return;
      nextVideoRedirected = true;
      setTimeout(() => { nextVideoRedirected = false }, 500);

      // Get player
      const playerEl = document.getElementById("ytd-player");
      const player = playerEl?.getPlayer();

      // Sanitize seed
      let seed = Date.now();
      if (seedInput.value) {
        const sanitized = seedInput.value.trim().replaceAll(/[^\d]/g, "");
        seed = parseInt(sanitized);
        seedInput.value = seed;
        seedInput.dispatchEvent(new Event("change"));
      }

      // Aggregated playlist
      if (masterPlaylist.aggregate) {
        // Sort all into oldest first order
        mapping.sort((a, b) => a.publishedAt - b.publishedAt);
      }

      // Shuffle
      // Shuffle uses deterministic random in such a manner that it assures additions of new videos
      // won't completely change the order of the shuffled list for a certain seed
      const shuffled = shuffleCheck.checked ? stableSeededSort(mapping, seed) : mapping;
      let randomIndex = Date.now() % mapping.length;
      const currentVideoId = player?.getVideoData().video_id;
      if (currentVideoId) {
        const currentIndex = shuffled.findIndex(video => video.id === currentVideoId);
        if (currentIndex !== -1) {
          randomIndex = (currentIndex + override + mapping.length) % mapping.length;
        }
      }
      const videoInfo = shuffled[randomIndex]; 
      const videoId = videoInfo.id;

      // Change page
      const href = `/watch?v=${videoId}`;
      const mpName = masterPlaylist.name.replaceAll(/\s/g, "_");
      const i = `(${randomIndex}/${mapping.length})`;
      const hash = `#${mpName}_${i}`;

      // If player is visible
      if (player && isPlayerVisible(player)) {

        // changeAppVideo is private method of youtube app that can change video along with
        // - page title
        // - video info (ytd-watch-metadata)
        // - comments
        if (changeAppVideo) {
          changeAppVideo(videoId);
          (async () => {
            for (let i = 1; i <= 25; i++) {
              if (window.location.href.includes(videoId)) {
                history.replaceState({}, '', hash);
                return;
              }
              await new Promise(resolve => setTimeout(resolve, 20 * i));
            }
          })();

        } else {
          // #ytd-player.getPlayer().loadVideoById only changes the video without changing the three
          // so it is used as fallback here when the script has become deprecated
          markDeprecated();
          player.loadVideoById(videoId);
          history.pushState({}, '', href + hash);
        }

      } else {
        // This fully reloads the page
        window.location.href = href + hash;
      }

    };
    prevButton.addEventListener('click', () => { manualEnable(); nextVideo(-1) });
    nextButton.addEventListener('click', () => { manualEnable(); nextVideo() });

    const onNavigate = () => {
      let videoInterval = setInterval(() => {
        const player = document.getElementById("ytd-player")?.getPlayer();
        if (player) {
          clearInterval(videoInterval);

          player.addEventListener("onStateChange", () => {
            if (player.getPlayerState() === YT_PLAYER_STATE_ENDED) nextVideo();
          });

          // Refresh the cache when the end is near
          // to ensure cache is up to date when changing video
          let lastRefresh = 0;
          const video = document.getElementById("ytd-player").querySelector("video");
          if (video) {
            let lastct = 0;
            let onupdate;
            onupdate = async () => {
              const d = player.getDuration();
              const ct = player.getCurrentTime();
              const dct = ct - lastct;
              lastct = ct;

              // Detect manual time change
              if (Math.abs(dct) >= 2.0 * player.getPlaybackRate()) {
                return;
              }

              // Check last refresh
              const now = Date.now();
              if (now - lastRefresh < 30 * 60 * 1000) {
                return;
              }

              // Refresh playlist in advance when nearing the end
              if ((d > 1200 && d - ct < 310 && d - ct > 90) ||
                (d > 600 && d - ct < 190 && d - ct > 90) ||
                (d > 300 && d - ct < 110 && d - ct > 90)) { // 2000+ channel takes tens of seconds to fetch

                lastRefresh = now;

                const masterPlaylists = getMasterPlaylists();
                const masterPlaylist = masterPlaylists[currentMasterId];
                if (masterPlaylist) {
                  await refreshMasterPlaylist(masterPlaylist);
                }
              }
            };
            video.addEventListener("timeupdate", onupdate);
          }
        }
      }, 300);
    };
    onNavigate();

  });

})();
