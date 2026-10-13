/** Never log arbitrary exception messages/stacks: they can contain connection strings or tokens. */
export function startupFailure(error: unknown, port?: number): string {
  const target = port === undefined ? '설정된 포트' : `${port}번 포트`;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  switch (code) {
    case 'EADDRINUSE':
      return `[EADDRINUSE] ${target}가 이미 사용 중입니다. 기존 API 서버를 종료하거나 PORT를 변경하세요.`;
    case 'EACCES':
    case 'EPERM':
      return `[${code}] ${target}에 연결할 권한이 없습니다. PORT와 실행 권한을 확인하세요.`;
    case 'EADDRNOTAVAIL':
      return '[EADDRNOTAVAIL] 바인딩할 네트워크 주소를 사용할 수 없습니다. 실행 환경의 네트워크 설정을 확인하세요.';
    case 'ECONNREFUSED':
      return '[ECONNREFUSED] 외부 서비스 연결이 거부되었습니다. DB 등 필요한 서비스의 실행 상태를 확인하세요.';
    case 'ETIMEDOUT':
      return '[ETIMEDOUT] 서비스 연결 시간이 초과되었습니다. 네트워크와 연결 설정을 확인하세요.';
  }
  const message = error instanceof Error ? error.message : '';
  // Only these exact, value-free messages are safe to expose.
  const configurationErrors: Record<string, string> = {
    'PORT must be between 1 and 65535': 'PORT는 1~65535 사이의 정수여야 합니다.',
    'TRUST_PROXY_HOPS must be 0 or 1 after verifying proxy topology': 'TRUST_PROXY_HOPS는 프록시 구성을 확인한 뒤 0 또는 1로 설정하세요.',
    'CORS_ALLOWED_ORIGINS must contain exact HTTP(S) origins': 'CORS_ALLOWED_ORIGINS에는 http(s)://호스트:포트 형식의 origin을 쉼표로 구분해 넣으세요. 경로와 마지막 /는 제외하세요.',
  };
  if (Object.hasOwn(configurationErrors, message)) return `[CONFIG] ${configurationErrors[message]}`;
  const name = error instanceof Error ? error.constructor.name : '';
  if (['UnknownDependenciesException', 'UndefinedDependencyException', 'UnknownModuleException', 'UndefinedModuleException'].includes(name)) {
    return `[${name}] Nest 모듈 또는 의존성 주입 초기화에 실패했습니다. providers/imports/exports 연결과 최근 변경을 확인하세요.`;
  }
  const type = ['TypeError', 'RangeError', 'ReferenceError', 'SyntaxError'].includes(name) ? name : 'UNKNOWN';
  return `[${type}] 예상하지 못한 초기화 오류입니다. 최근 서버 변경과 모듈 초기화를 확인하세요. 비밀값 보호를 위해 원문 메시지와 스택은 출력하지 않습니다.`;
}
