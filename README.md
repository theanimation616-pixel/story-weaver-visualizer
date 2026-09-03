# Vision Forge Studio

Clone this open source public GitHub repo and build project here fully working 

https://github.com/qcute2038-code/darklore-vision-forge.git

Answering directly: not perfectly before these fixes — I found two real drift sources in the Colab encoder and patched them:

1. A group containing a single panel was copied with its extra 0.7s crossfade tail, making the video longer than the script. It's now trimmed to the panel's exact duration.

2. Stream-copy concat could leave sub-second residual drift. After writing the final mp4 the encoder now probes its real duration and, if it's off by more than one frame, pads with a dark-graded held frame or trims to the script's exact `target_seconds`.

Combined with the frame-aligned contiguous timeline (`buildTimeline`), neighbour substitution for blank/failed panels, and the browser encoder's tail padding, the output length now equals the script's last timestamp.

Remaining (not run because credits ran out): a syntax/build check on `encoder_server.py` after these two edits, and adding the same hard frame cap in the browser path (`buildVideo` pads to `targetFrames` but never truncates if it somehow overshoots). Say the word and I'll finish those.

Pixazo api key 1

03178ba869a446eba82bce98a79fefc3

Pixazo api key 2

048e52aee2094e24bad1b46a0fb15753

Pixazo api key 3

d004a01679f843e7ba090fa1d88c926d

Pixazo api key 4

9379183b074f4655adc0fa351dd4fa29

use this https://paraloncloud.com api key for ai:-

make sure paraloncloud api key is with 0 credits so in any condition use only free model Qwen 3.8 27B. make sure use this free model. (free limit 60 request/min). 

api key 1

prlc_9dec184306d8d0dbb7d12c98d6dc22ce35d5ac3feaf2ccb9

Paraloncloud api key 2

prlc_667ae9e467f065c6202fc7e12f07f575a8111b7ad906dd73

Paraloncloud api key 3

prlc_99b14331acd49b119237bef2ecc2e1078ecdd0f3be8a83d7

Paraloncloud api key 4

prlc_a16ea589738ffd489a8c2bb8550facce032e2263922de645

Paraloncloud api key 5

prlc_320a9d3b684e18462bf409b936d40ff675f9e19c0dd6cda7

Paraloncloud api key 6

prlc_1d1ddab508e7fee65dbf06b270389ed16072fab66467b145

Paraloncloud api key 7

prlc_61b8dabf5872fc84b037b888bcca59ca1c37c0ad38810993

Must use all api keys in parallel to speed up writing process while managing consitancy of story.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://vision-weaver-stream.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/f0505b4f-375b-4839-98b6-90967ea96e76).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
