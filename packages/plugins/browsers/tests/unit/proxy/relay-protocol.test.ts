import { describe, it } from 'bun:test';
import should from 'should';
import {
  badRequest,
  basicProxyAuthorization,
  connectHead,
  forwardedHead,
  gatewayFailure,
  headEnd,
  parseAuthority,
  parsePlainTarget,
  parseRequestHead,
  proxyUnreachable,
  responseStatus,
  socks5,
} from '../../../../src/lib/index.ts';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('relay request heads', () => {
  it('should find where a head ends, and only once it is complete', () => {
    // Act + Assert
    should(headEnd(bytes('GET / HTTP/1.1\r\nHost: x\r\n'))).equal(-1);
    should(headEnd(bytes('GET / HTTP/1.1\r\nHost: x\r\n\r\nbody'))).equal(27);
  });

  it('should read a request line and its headers', () => {
    // Act
    const head = parseRequestHead('CONNECT a.example:443 HTTP/1.1\r\nHost: a.example:443\r\nUser-Agent: x\r\n\r\n');

    // Assert
    should(head).eql({
      method: 'CONNECT',
      target: 'a.example:443',
      version: 'HTTP/1.1',
      headers: [
        ['Host', 'a.example:443'],
        ['User-Agent', 'x'],
      ],
    });
  });

  it('should refuse a head that is not HTTP', () => {
    // Act + Assert
    should(parseRequestHead('hello\r\n\r\n')).be.undefined();
    should(parseRequestHead('GET / HTTP/1.1\r\nbroken header\r\n\r\n')).be.undefined();
  });

  it('should read a host and port, bracketed for IPv6', () => {
    // Act + Assert
    should(parseAuthority('a.example:443')).eql({ host: 'a.example', port: 443 });
    should(parseAuthority('[::1]:8443')).eql({ host: '::1', port: 8443 });
    should(parseAuthority('a.example')).be.undefined();
    should(parseAuthority('a.example:0')).be.undefined();
    should(parseAuthority('a.example:70000')).be.undefined();
  });

  it('should split a plain request into where it goes and what the origin sees', () => {
    // Act + Assert
    should(parsePlainTarget('http://a.example/p?q=1')).eql({
      destination: { host: 'a.example', port: 80 },
      path: '/p?q=1',
    });
    should(parsePlainTarget('http://a.example:8080')?.path).equal('/');
    should(parsePlainTarget('https://a.example/')).be.undefined();
    should(parsePlainTarget('not a url')).be.undefined();
  });
});

describe('relay outgoing heads', () => {
  it('should sign in with Basic credentials', () => {
    // Act + Assert
    should(basicProxyAuthorization('alice', 's3cret')).equal(`Basic ${btoa('alice:s3cret')}`);
  });

  it('should replace the hop-by-hop headers and sign in for itself', () => {
    // Arrange
    const head = parseRequestHead(
      'GET http://a.example/ HTTP/1.1\r\nHost: a.example\r\nProxy-Authorization: Basic eA==\r\nProxy-Connection: keep-alive\r\nAccept: */*\r\n\r\n',
    );

    // Act
    const text = forwardedHead(head as NonNullable<typeof head>, 'http://a.example/', 'Basic Zm9v');

    // Assert
    should(text).equal(
      'GET http://a.example/ HTTP/1.1\r\nHost: a.example\r\nAccept: */*\r\nProxy-Authorization: Basic Zm9v\r\nConnection: close\r\n\r\n',
    );
  });

  it('should send no sign-in when none is given', () => {
    // Arrange
    const head = parseRequestHead('GET http://a.example/x HTTP/1.1\r\nHost: a.example\r\n\r\n');

    // Act + Assert
    should(forwardedHead(head as NonNullable<typeof head>, '/x')).not.containEql('Proxy-Authorization');
  });

  it('should open a tunnel with the sign-in, bracketing an IPv6 host', () => {
    // Act + Assert
    should(connectHead({ host: 'a.example', port: 443 }, 'Basic Zm9v')).equal(
      'CONNECT a.example:443 HTTP/1.1\r\nHost: a.example:443\r\nProxy-Authorization: Basic Zm9v\r\n\r\n',
    );
    should(connectHead({ host: '::1', port: 443 }, 'Basic Zm9v')).startWith('CONNECT [::1]:443 HTTP/1.1');
  });

  it('should read a response status, and wait for the head to finish', () => {
    // Act + Assert
    should(responseStatus(bytes('HTTP/1.1 200 OK\r\n'))).be.undefined();
    should(responseStatus(bytes('HTTP/1.1 407 Proxy Authentication Required\r\nX: y\r\n\r\nrest'))).eql({
      code: 407,
      length: 52,
    });
    should(responseStatus(bytes('garbage\r\n\r\n'))?.code).equal(0);
  });

  it('should answer a bad gateway with the reason, and a bad request without a body', () => {
    // Act + Assert
    should(gatewayFailure('it broke')).startWith('HTTP/1.1 502 Bad Gateway');
    should(gatewayFailure('it broke')).endWith('\r\n\r\nit broke\n');
    should(badRequest()).startWith('HTTP/1.1 400');
  });

  it('should say which proxy could not be reached, with no credential in the sentence', () => {
    // Act + Assert
    should(proxyUnreachable({ scheme: 'socks5', host: 'p.example', port: 1080 })).equal(
      'the browser proxy at socks5://p.example:1080 could not be reached',
    );
  });
});

describe('SOCKS5 messages', () => {
  it('should offer sign-in only when there are credentials to give', () => {
    // Act + Assert
    should([...socks5.greeting(true)]).eql([5, 2, 0, 2]);
    should([...socks5.greeting(false)]).eql([5, 1, 0]);
  });

  it('should read the method the server chose', () => {
    // Act + Assert
    should(socks5.methodChoice(new Uint8Array([5]))).be.undefined();
    should(socks5.methodChoice(new Uint8Array([5, 0]))).equal('none');
    should(socks5.methodChoice(new Uint8Array([5, 2]))).equal('password');
    should(socks5.methodChoice(new Uint8Array([5, 0xff]))).equal('refused');
    should(socks5.methodChoice(new Uint8Array([4, 0]))).equal('refused');
  });

  it('should frame a username and password, and refuse one SOCKS5 cannot carry', () => {
    // Act + Assert
    should([...(socks5.authRequest('ab', 'c') as Uint8Array)]).eql([1, 2, 97, 98, 1, 99]);
    should(socks5.authRequest('', 'c')).be.undefined();
    should(socks5.authRequest('a'.repeat(256), 'c')).be.undefined();
  });

  it('should read whether the sign-in was accepted', () => {
    // Act + Assert
    should(socks5.authAccepted(new Uint8Array([1]))).be.undefined();
    should(socks5.authAccepted(new Uint8Array([1, 0]))).be.true();
    should(socks5.authAccepted(new Uint8Array([1, 1]))).be.false();
  });

  it('should ask to connect by IPv4, IPv6 or name', () => {
    // Act + Assert
    should([...(socks5.connectRequest({ host: '10.0.0.1', port: 443 }) as Uint8Array)]).eql([
      5, 1, 0, 1, 10, 0, 0, 1, 1, 187,
    ]);
    should([...(socks5.connectRequest({ host: 'ab.c', port: 80 }) as Uint8Array)]).eql([
      5, 1, 0, 3, 4, 97, 98, 46, 99, 0, 80,
    ]);
    const v6 = socks5.connectRequest({ host: '::1', port: 80 }) as Uint8Array;
    should(v6[3]).equal(4);
    should(v6.length).equal(22);
    should(v6[19]).equal(1);
    should(socks5.connectRequest({ host: '300.0.0.1', port: 80 })).be.undefined();
    should(socks5.connectRequest({ host: 'x:y:z', port: 80 })).be.undefined();
  });

  it('should read where a connect reply ends, or why it failed', () => {
    // Act + Assert
    should(socks5.connectReply(new Uint8Array([5, 0, 0]))).eql({ state: 'incomplete' });
    should(socks5.connectReply(new Uint8Array([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))).eql({ state: 'ok', length: 10 });
    should(socks5.connectReply(new Uint8Array([5, 0, 0, 1, 0, 0]))).eql({ state: 'incomplete' });
    should(socks5.connectReply(new Uint8Array([5, 0, 0, 3, 2, 97, 98, 0, 80]))).eql({ state: 'ok', length: 9 });
    should(socks5.connectReply(new Uint8Array([5, 5, 0, 1]))).have.property('state', 'failed');
    should(socks5.connectReply(new Uint8Array([4, 0, 0, 1]))).have.property('state', 'failed');
    should(socks5.connectReply(new Uint8Array([5, 0, 0, 9]))).have.property('state', 'failed');
  });

  it('should say in words why a SOCKS5 connect failed, for every code the protocol defines', () => {
    // Act
    const why = [1, 2, 3, 4, 5, 6, 7, 8].map(code => {
      const reply = socks5.connectReply(new Uint8Array([5, code, 0, 1]));
      return reply.state === 'failed' ? reply.why : '';
    });

    // Assert
    should(new Set(why).size).equal(8);
    should(why[0]).equal('the proxy reported a general failure');
    should(why[1]).equal('the proxy refused the connection by its rules');
    should(why[2]).equal('the proxy has no route to that network');
    should(why[3]).equal('the proxy could not reach that host');
    should(why[4]).equal('that host refused the connection');
    should(why[5]).equal('the connection timed out at the proxy');
    should(why[6]).equal('the proxy does not support that command');
    should(why[7]).equal('the proxy does not support that address type');
    should(socks5.connectReply(new Uint8Array([5, 9, 0, 1]))).have.property(
      'why',
      'the proxy reported a general failure',
    );
  });

  it('should read the end of an IPv6 connect reply', () => {
    // Act + Assert
    should(socks5.connectReply(new Uint8Array([5, 0, 0, 4, ...new Array(18).fill(0)]))).eql({
      state: 'ok',
      length: 22,
    });
  });
});
