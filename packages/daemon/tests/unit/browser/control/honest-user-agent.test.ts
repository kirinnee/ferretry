import { describe, it } from 'bun:test';
import should from 'should';
import {
  agentBrowserArguments,
  chromeLaunchArguments,
  chromePlatformToken,
  chromeProxyArguments,
  honestChromeUserAgent,
} from '../../../../src/lib/index.ts';

const VIEWPORT = { width: 1280, height: 800 };
const PORT = { kind: 'port', port: 9222 } as const;
const VERSION = 'Google Chrome 154.0.7558.52 ';

describe('honest user agent', () => {
  it("should be the browser's own major version in the platform token of the OS it runs on", () => {
    // Act + Assert
    should(honestChromeUserAgent(VERSION, 'linux', 'x64')).equal(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
    );
    should(honestChromeUserAgent('Chromium 150.1.2.3', 'linux', 'arm64')).equal(
      'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    );
    should(honestChromeUserAgent(VERSION, 'darwin', 'arm64')).containEql('Macintosh; Intel Mac OS X 10_15_7');
    should(honestChromeUserAgent(VERSION, 'win32', 'x64')).containEql('Windows NT 10.0; Win64; x64');
  });

  it('should never contain the headless token and never name another browser', () => {
    // Act
    const agent = honestChromeUserAgent(VERSION, 'linux', 'x64') as string;

    // Assert
    should(agent).not.match(/Headless/iu);
    should(agent).not.match(/Firefox|Edg\/|Safari\/\d+\.\d+\.\d+|Android|iPhone/u);
  });

  it('should say nothing rather than guess for a version or an OS it does not recognise', () => {
    // Act + Assert
    should(honestChromeUserAgent('Google Chrome', 'linux', 'x64')).be.undefined();
    should(honestChromeUserAgent(VERSION, 'freebsd', 'x64')).be.undefined();
    should(honestChromeUserAgent(VERSION, 'linux', 'riscv64')).be.undefined();
    should(honestChromeUserAgent(VERSION, 'win32', 'arm64')).be.undefined();
    should(chromePlatformToken('aix', 'x64')).be.undefined();
  });

  it('should reach a headless launch and be ignored by a real window, which already says Chrome', () => {
    // Arrange
    const userAgent = honestChromeUserAgent(VERSION, 'linux', 'x64') as string;

    // Act
    const headless = agentBrowserArguments('chrome', '/p', PORT, VIEWPORT, 'linux', 'headless', { userAgent });
    const window = agentBrowserArguments('chrome', '/p', PORT, VIEWPORT, 'linux', 'window', { userAgent });

    // Assert
    should(headless).containEql(`--user-agent=${userAgent}`);
    should(window.some(argument => argument.startsWith('--user-agent'))).be.false();
  });

  it('should leave the launch as it was when no extras are given', () => {
    // Act
    const plain = agentBrowserArguments('chrome', '/p', PORT, VIEWPORT, 'linux', 'headless');

    // Assert
    should(plain.some(argument => argument.startsWith('--user-agent'))).be.false();
    should(plain.some(argument => argument.startsWith('--proxy-server'))).be.false();
  });
});

describe('browser proxy switches', () => {
  it('should send traffic to the server and keep WebRTC from reaching around it', () => {
    // Act + Assert
    should(chromeProxyArguments('socks5://p.example:1080', [])).eql([
      '--proxy-server=socks5://p.example:1080',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ]);
  });

  it('should join the bypass list the way Chrome reads it', () => {
    // Act
    const args = chromeProxyArguments('http://p:8080', ['*.internal.example', '10.0.0.0/8']);

    // Assert
    should(args).containEql('--proxy-bypass-list=*.internal.example;10.0.0.0/8');
  });

  it('should be part of a launch only when a proxy is given', () => {
    // Act
    const proxied = chromeLaunchArguments('chrome', '/p', PORT, VIEWPORT, 'linux', {
      headless: true,
      proxy: { server: 'http://127.0.0.1:4000', bypass: [] },
    });
    const direct = chromeLaunchArguments('chrome', '/p', PORT, VIEWPORT, 'linux', { headless: true });

    // Assert
    should(proxied).containEql('--proxy-server=http://127.0.0.1:4000');
    should(direct.some(argument => argument.startsWith('--proxy-server'))).be.false();
  });
});
