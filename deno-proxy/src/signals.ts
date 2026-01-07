// 分隔符集合定义
export interface DelimiterSet {
  open: string;
  close: string;
  mid: string;
}

// 6组罕见 Unicode 字符分隔符
const DELIMITER_SETS: DelimiterSet[] = [
  { open: '༒', close: '༒', mid: '࿇' },
  { open: '꧁', close: '꧂', mid: '࿔' },
  { open: '᎒', close: '᎒', mid: '᎓' },
  { open: 'ꆈ', close: 'ꆈ', mid: 'ꊰ' },
  { open: '꩜', close: '꩜', mid: '꩟' },
  { open: 'ꓸ', close: 'ꓸ', mid: 'ꓹ' },
];

// 20个后缀字符池
const SUFFIX_POOL = [
  '龘', '靐', '齉', '麤', '爨', '驫', '鱻', '羴', '犇', '骉',
  '飝', '厵', '靇', '飍', '馫', '灥', '厽', '叒', '叕', '芔',
];

// 分隔符标记接口
export interface DelimiterMarkers {
  TC_START: string;      // 工具调用块开始
  TC_END: string;        // 工具调用块结束
  NAME_START: string;    // 函数名开始
  NAME_END: string;      // 函数名结束
  ARGS_START: string;    // 参数开始
  ARGS_END: string;      // 参数结束
  RESULT_START: string;  // 工具结果开始
  RESULT_END: string;    // 工具结果结束
}

/**
 * 工具调用分隔符生成器
 * 每次实例化时随机选择一组分隔符和后缀，生成唯一的标记组合
 */
export class ToolCallDelimiter {
  private markers: DelimiterMarkers;

  constructor() {
    this.markers = this.generateMarkers();
  }

  /**
   * 生成一组随机分隔符标记
   */
  private generateMarkers(): DelimiterMarkers {
    // 随机选择一组分隔符
    const set = DELIMITER_SETS[Math.floor(Math.random() * DELIMITER_SETS.length)];
    
    // 随机选择两个不同的后缀
    const suffix1 = SUFFIX_POOL[Math.floor(Math.random() * SUFFIX_POOL.length)];
    let suffix2 = SUFFIX_POOL[Math.floor(Math.random() * SUFFIX_POOL.length)];
    
    // 确保两个后缀不同
    while (suffix2 === suffix1 && SUFFIX_POOL.length > 1) {
      suffix2 = SUFFIX_POOL[Math.floor(Math.random() * SUFFIX_POOL.length)];
    }

    const { open, close, mid } = set;

    return {
      TC_START: `${open}${suffix1}ᐅ`,
      TC_END: `ᐊ${suffix1}${close}`,
      NAME_START: `${mid}▸`,
      NAME_END: `◂${mid}`,
      ARGS_START: `${mid}▹`,
      ARGS_END: `◃${mid}`,
      RESULT_START: `${open}${suffix2}⟫`,
      RESULT_END: `⟪${suffix2}${close}`,
    };
  }

  /**
   * 获取所有标记
   */
  getMarkers(): DelimiterMarkers {
    return this.markers;
  }

  /**
   * 获取标记的描述信息（用于日志和调试）
   */
  describe(): string {
    const entries = Object.entries(this.markers);
    return entries
      .map(([key, value]) => {
        // 同时显示字符和 Unicode 码点
        const codePoints = [...value]
          .map(char => `U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
          .join(' ');
        return `  ${key}: "${value}" (${codePoints})`;
      })
      .join('\n');
  }

  /**
   * 生成工具调用示例（用于 prompt）
   */
  getExampleFormat(functionName = 'function_name', args = '{"param": "value"}'): string {
    const m = this.markers;
    return `${m.TC_START}\n${m.NAME_START}${functionName}${m.NAME_END}\n${m.ARGS_START}${args}${m.ARGS_END}\n${m.TC_END}`;
  }
}