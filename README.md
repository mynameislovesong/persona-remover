# 페르소나 리무버 (Persona Remover)

채팅, RP, 메시지, UI 로그 스크린샷에서 특정 페르소나 이름을 찾아 지우는 브라우저 전용 정적 웹앱입니다. React와 Tesseract.js, Canvas API만으로 이미지 읽기부터 OCR, 편집, PNG/ZIP 생성까지 사용자 기기 안에서 처리합니다.

## 주요 기능

- PNG, JPG, JPEG, WebP 다중 업로드와 드래그 앤 드롭
- 브라우저 디코더를 이용한 EXIF 방향 정규화 및 원본 픽셀 크기 유지
- 한국어 + 영어 OCR, 이미지별 진행률과 오류 상태
- OCR 결과 캐시: 검색어와 검색 모드를 바꿔도 재분석하지 않음
- 정확히 일치 / 포함 일치, 공백과 줄바꿈 차이를 자동 보정해 OCR이 나눈 글자도 이어서 검색
- 검출 박스 미리보기, 박스별 선택/해제, 전체 OCR 텍스트 위치 강조
- 주변 테두리 픽셀의 우세 색상과 중앙값을 이용한 배경 채우기
- 이름을 완전히 지우거나 원하는 텍스트로 치환하는 처리 방식 선택 (기본값 `□□`)
- 0~16px 삭제 여백, 원본/편집 결과 전환
- 원본과 동일한 픽셀 크기의 PNG 및 여러 결과 ZIP 다운로드
- 데스크톱과 모바일 반응형 UI

## 로컬 실행

Node.js 20 이상을 권장합니다.

```bash
npm install
npm run dev
```

터미널에 표시되는 로컬 주소를 브라우저에서 엽니다.

## 프로덕션 빌드

```bash
npm run build
```

결과는 `dist/`에 생성됩니다. HTML, CSS, JavaScript와 정적 에셋만 있으므로 별도 서버 런타임 없이 배포할 수 있습니다. 로컬에서 배포 결과를 확인하려면 다음을 실행합니다.

```bash
npm run preview
```

## GitHub Pages 배포

공개 저장소 이름을 `persona-remover`, 기본 브랜치를 `main`으로 두고 프로젝트를 푸시합니다. `vite.config.ts`의 `base`는 이 저장소 하위 경로인 `/persona-remover/`로 설정되어 있으며, 포함된 `.github/workflows/deploy-pages.yml`이 자동으로 빌드하고 배포합니다.

1. GitHub 저장소의 **Settings → Pages**로 이동합니다.
2. **Build and deployment → Source**에서 **GitHub Actions**를 선택합니다.
3. **Actions → Deploy static site to Pages → Run workflow**를 누르거나 `main` 브랜치에 푸시합니다.
4. 배포가 완료되면 `https://mynameislovesong.github.io/persona-remover/`로 접속합니다.

`main` 브랜치에 이후 변경사항을 푸시할 때도 같은 워크플로가 자동 실행됩니다. 최종 주소는 저장소 화면이 아니라 로그인 없이 바로 열리는 공개 웹사이트입니다.

## 개인정보와 네트워크 동작

사용자가 선택한 이미지는 `File`/`Blob` 객체로만 유지됩니다. 브라우저가 이미지를 디코딩하고 Canvas에서 픽셀을 읽고 수정하며, 완성된 PNG와 ZIP도 브라우저 메모리에서 생성합니다. 앱에는 이미지 업로드용 `fetch`, XHR, 폼 전송 또는 백엔드 엔드포인트가 없습니다. 새로고침하면 브라우저 메모리에 있던 이미지와 OCR 결과도 사라집니다.

Tesseract.js는 처음 OCR을 실행할 때 다음 공개 정적 파일을 내려받을 수 있습니다.

- Tesseract Web Worker 스크립트
- OCR 엔진 WebAssembly(WASM)
- 한국어(`kor`)와 영어(`eng`) 학습 데이터(`traineddata`)

이 요청은 실행 코드와 언어 모델을 받기 위한 것이며 사용자의 이미지 데이터는 포함하지 않습니다. 내려받은 파일은 브라우저 캐시에 재사용될 수 있습니다. OCR 자체는 Web Worker에서 로컬로 실행됩니다.

## 백엔드가 필요 없는 이유

- 파일 선택: 브라우저 File API
- 이미지 방향 정규화와 편집: HTML Canvas API
- OCR: 브라우저 Web Worker에서 실행되는 Tesseract.js + WASM
- 결과 생성: `canvas.toBlob()`
- 다중 다운로드: JSZip이 브라우저 메모리에서 ZIP 생성

처리, 저장, 계정, 동기화가 모두 서버 기능을 요구하지 않으므로 정적 호스팅만으로 완전히 동작합니다.

## 프로젝트 구조

```text
src/
  App.tsx         화면, OCR 큐, 상태, 다운로드 흐름
  imageUtils.ts   EXIF 정규화, Canvas 편집, 배경색 추정
  search.ts       정확히/포함 매칭과 공백·줄바꿈 자동 보정
  styles.css      데스크톱·모바일 레이아웃
  types.ts        이미지와 OCR 데이터 타입
.github/workflows/deploy-pages.yml
vite.config.ts
```

## 브라우저 참고

최신 Chrome, Edge, Firefox, Safari를 권장합니다. 고해상도 이미지는 원본 크기로 유지되므로 여러 장을 처리할 때 기기 메모리에 따라 시간이 걸릴 수 있습니다. iPhone Safari에서도 순차 OCR로 동시에 큰 캔버스를 여러 개 만들지 않도록 구성되어 있습니다.
