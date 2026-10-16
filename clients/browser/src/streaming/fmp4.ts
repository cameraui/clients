const MOOV = 0x6d6f6f76;
const TRAK = 0x7472616b;
const TKHD = 0x746b6864;
const MDIA = 0x6d646961;
const MDHD = 0x6d646864;
const HDLR = 0x68646c72;
const MVEX = 0x6d766578;
const TREX = 0x74726578;
const MOOF = 0x6d6f6f66;
const TRAF = 0x74726166;
const TFHD = 0x74666864;
const TFDT = 0x74666474;
const TRUN = 0x7472756e;
const VIDE = 0x76696465;

const SAMPLE_IS_NON_SYNC = 0x10000;
const MAX_RUN_SAMPLES = 4096;

interface TrackInfo {
  timescale: number;
  video: boolean;
  defaultDuration: number;
  defaultFlags: number;
}

interface TrackFragment {
  track?: TrackInfo;
  baseTime?: number;
  duration: number;
  flags: number;
}

type BoxVisitor = (type: number, start: number, end: number) => void;

export interface Fmp4KeyframeScanner {
  readonly hasVideo: boolean | undefined;
  scan: (data: ArrayBuffer, onKeyframe: (time: number) => void) => void;
}

export function createFmp4KeyframeScanner(): Fmp4KeyframeScanner {
  const tracks = new Map<number, TrackInfo>();
  let hasVideo: boolean | undefined;

  function parseInit(view: DataView, start: number, end: number): void {
    const parsed = new Map<number, { timescale: number; video: boolean }>();
    const defaults = new Map<number, { duration: number; flags: number }>();

    forEachBox(view, start, end, (type, s, e) => {
      if (type === TRAK) {
        const trak = { id: -1, timescale: 0, video: false };
        forEachBox(view, s, e, (t, ts, te) => {
          if (t === TKHD && ts + 24 <= te) {
            trak.id = view.getUint32(ts + (view.getUint8(ts) === 1 ? 20 : 12));
          } else if (t === MDIA) {
            forEachBox(view, ts, te, (m, ms, me) => {
              if (m === MDHD && ms + 24 <= me) trak.timescale = view.getUint32(ms + (view.getUint8(ms) === 1 ? 20 : 12));
              else if (m === HDLR && ms + 12 <= me) trak.video = view.getUint32(ms + 8) === VIDE;
            });
          }
        });
        if (trak.id >= 0 && trak.timescale > 0) parsed.set(trak.id, trak);
      } else if (type === MVEX) {
        forEachBox(view, s, e, (t, ts, te) => {
          if (t === TREX && ts + 24 <= te) defaults.set(view.getUint32(ts + 4), { duration: view.getUint32(ts + 12), flags: view.getUint32(ts + 20) });
        });
      }
    });

    tracks.clear();
    for (const [id, { timescale, video }] of parsed) {
      const trex = defaults.get(id);
      tracks.set(id, { timescale, video, defaultDuration: trex?.duration ?? 0, defaultFlags: trex?.flags ?? 0 });
    }
    hasVideo = [...tracks.values()].some((track) => track.video);
  }

  function scanTrackFragment(view: DataView, start: number, end: number, onKeyframe: (time: number) => void): void {
    const fragment: TrackFragment = { duration: 0, flags: 0 };

    forEachBox(view, start, end, (type, s, e) => {
      if (type === TFHD && s + 8 <= e) {
        const track = tracks.get(view.getUint32(s + 4));
        const flags = view.getUint32(s) & 0xffffff;
        const length = 8 + (flags & 0x01 ? 8 : 0) + (flags & 0x02 ? 4 : 0) + (flags & 0x08 ? 4 : 0) + (flags & 0x10 ? 4 : 0) + (flags & 0x20 ? 4 : 0);
        if (!track?.video || s + length > e) return;
        let p = s + 8 + (flags & 0x01 ? 8 : 0) + (flags & 0x02 ? 4 : 0);
        fragment.duration = track.defaultDuration;
        fragment.flags = track.defaultFlags;
        if (flags & 0x08) {
          fragment.duration = view.getUint32(p);
          p += 4;
        }
        if (flags & 0x10) p += 4;
        if (flags & 0x20) fragment.flags = view.getUint32(p);
        fragment.track = track;
      } else if (type === TFDT && s + 8 <= e) {
        if (view.getUint8(s) === 0) fragment.baseTime = view.getUint32(s + 4);
        else if (s + 12 <= e) fragment.baseTime = view.getUint32(s + 4) * 2 ** 32 + view.getUint32(s + 8);
      } else if (type === TRUN && isPlaced(fragment)) {
        fragment.baseTime = scanRun(view, s, e, fragment, onKeyframe);
      }
    });
  }

  function scan(data: ArrayBuffer, onKeyframe: (time: number) => void): void {
    const view = new DataView(data);
    forEachBox(view, 0, view.byteLength, (type, start, end) => {
      if (type === MOOV) {
        parseInit(view, start, end);
      } else if (type === MOOF && hasVideo) {
        forEachBox(view, start, end, (t, s, e) => {
          if (t === TRAF) scanTrackFragment(view, s, e, onKeyframe);
        });
      }
    });
  }

  return {
    get hasVideo() {
      return hasVideo;
    },
    scan,
  };
}

function forEachBox(view: DataView, from: number, to: number, visit: BoxVisitor): void {
  let offset = from;
  while (offset + 8 <= to) {
    let size = view.getUint32(offset);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > to) return;
      size = view.getUint32(offset + 8) * 2 ** 32 + view.getUint32(offset + 12);
      header = 16;
    } else if (size === 0) {
      size = to - offset;
    }
    if (size < header || offset + size > to) return;
    visit(view.getUint32(offset + 4), offset + header, offset + size);
    offset += size;
  }
}

function isPlaced(fragment: TrackFragment): fragment is Required<TrackFragment> {
  return fragment.track !== undefined && fragment.baseTime !== undefined;
}

function scanRun(view: DataView, start: number, end: number, fragment: Required<TrackFragment>, onKeyframe: (time: number) => void): number {
  if (start + 8 > end) return fragment.baseTime;
  const version = view.getUint8(start);
  const flags = view.getUint32(start) & 0xffffff;
  const count = view.getUint32(start + 4);
  let p = start + 8;
  if (flags & 0x001) p += 4;
  let firstFlags: number | undefined;
  if (flags & 0x004) {
    if (p + 4 > end) return fragment.baseTime;
    firstFlags = view.getUint32(p);
    p += 4;
  }
  const stride = (flags & 0x100 ? 4 : 0) + (flags & 0x200 ? 4 : 0) + (flags & 0x400 ? 4 : 0) + (flags & 0x800 ? 4 : 0);
  if (count > MAX_RUN_SAMPLES || p + count * stride > end) return fragment.baseTime;

  let time = fragment.baseTime;
  for (let i = 0; i < count; i++) {
    let duration = fragment.duration;
    let sampleFlags = i === 0 && firstFlags !== undefined ? firstFlags : fragment.flags;
    let offset = 0;
    if (flags & 0x100) {
      duration = view.getUint32(p);
      p += 4;
    }
    if (flags & 0x200) p += 4;
    if (flags & 0x400) {
      sampleFlags = view.getUint32(p);
      p += 4;
    }
    if (flags & 0x800) {
      offset = version === 0 ? view.getUint32(p) : view.getInt32(p);
      p += 4;
    }
    if (!(sampleFlags & SAMPLE_IS_NON_SYNC)) onKeyframe((time + offset) / fragment.track.timescale);
    time += duration;
  }
  return time;
}
