"""Bounded context from executed Playwright steps and already-published failure media."""
import base64
import re
import shutil
import subprocess
from pathlib import Path


def steps_for(results):
    result = next((r for r in reversed(results) if r.get('status') in ('failed', 'timedOut', 'interrupted')), {})
    steps = []

    visited = 0
    def walk(entries, depth=0):
        nonlocal visited
        if depth > 8 or not isinstance(entries, list):
            return
        for step in entries[:200]:
            visited += 1
            if visited > 400 or not isinstance(step, dict):
                return
            title = str(step.get('title', ''))
            # Never send fill/type arguments, test data or arbitrary step titles.
            action = next((a for a in ('click', 'goto', 'press', 'check', 'reload', 'toBeVisible', 'toHaveText', 'toEqual')
                           if re.search(r'\b' + a + r'\b', title, re.I)), None)
            # JSON reporter steps omit category; HTML/blob steps may include it.
            if action and step.get('category') in (None, 'pw:api', 'expect', 'test.step'):
                duration = step.get('duration', 0)
                entry = {'action': action, 'outcome': 'failed' if step.get('error') else 'completed',
                         'durationMs': max(0, min(int(duration), 600000)) if isinstance(duration, (int, float)) else 0}
                steps.append(entry)
            walk(step.get('steps', []), depth + 1)
    walk(result.get('steps', []))
    return steps[-24:]


def visual_parts(groups, failures, root):
    """Only fixed relative screenshot/video paths selected by the trusted publisher.

    Frames are a sample, not a claim to have watched the entire recording. Auth
    scenarios are excluded because their images can contain credentials or OTPs.
    No remote URL, trace, DOM, raw log or filesystem path is sent to the provider.
    """
    root = Path(root).resolve()
    parts, labels, budget = [], [], 6 * 1024 * 1024
    for group in groups:
        if group['facts'].get('intent') in ('sign_in', 'sign_in_and_logout', 'sign_out', 'create_test_account', 'cleanup_test_account'):
            continue
        item = next((f for f in failures if f.get('id') in group['failureIds']), {})
        for kind in ('screenshot', 'video'):
            relative = item.get(kind)
            if not isinstance(relative, str) or Path(relative).is_absolute() or '..' in Path(relative).parts:
                continue
            path = root / relative
            if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(root):
                continue
            if kind == 'screenshot' and path.suffix.lower() in ('.png', '.jpg', '.jpeg'):
                if path.stat().st_size > min(budget, 1500000):
                    continue
                content = path.read_bytes()
                mime = 'image/png' if path.suffix.lower() == '.png' else 'image/jpeg'
                label = group['id'] + ': captured failure screenshot'
            elif kind == 'video' and path.suffix.lower() in ('.webm', '.mp4') and shutil.which('ffmpeg'):
                if path.stat().st_size > 25000000:
                    continue
                try:
                    # A frame near the end shows the state preceding the failure.
                    frame = subprocess.run(['ffmpeg', '-v', 'error', '-sseof', '-2', '-i', str(path),
                        '-frames:v', '1', '-vf', 'scale=640:640:force_original_aspect_ratio=decrease', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'],
                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=3, check=True)
                    content, mime = frame.stdout, 'image/jpeg'
                except (OSError, subprocess.SubprocessError):
                    continue
                label = group['id'] + ': sampled video frame approximately two seconds before recording ends (not full video review)'
            else:
                continue
            if not content or len(content) > min(budget, 1500000):
                continue
            budget -= len(content)
            parts.extend([{'text': label}, {'inlineData': {'mimeType': mime, 'data': base64.b64encode(content).decode()}}])
            labels.append(label)
            if len(labels) >= 8:
                return parts, labels
    return parts, labels
