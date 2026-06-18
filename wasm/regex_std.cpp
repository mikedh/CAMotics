/*
  regex_std.cpp — std::regex implementation of cb::Regex for the wasm build.

  cbang's util/Regex.cpp is backed by RE2 (<re2/re2.h>), the only compiled cbang
  translation unit that pulls a native re2 header. Re-implementing the small
  cb::Regex API against std::regex (shipped by emscripten's libc++) lets us drop
  cbang's Regex.cpp from compilation and delete the entire native cbang/scons
  build that existed only to vendor re2/yaml headers.

  cb::Regex is live in the wasm core: regex-backed String::replace is called during
  G-code interpretation (GCodeMachine.cpp, GCodeInterpreter.cpp), so this must be a
  real implementation, not a stub.

  Grammar note: RE2 syntax is PCRE-ish; std::regex defaults to ECMAScript, which is
  the closest feature-rich match. The `posix` flag is ignored — the core's only
  patterns ("\\)" and " ") behave identically under any grammar. replace() uses
  std::regex_replace, whose backreference token is "$N" (RE2 uses "\\N"); the core
  only ever passes literal replacement strings, so this difference is moot.
*/
#include <cbang/util/Regex.h>

#include <regex>
#include <string>

namespace cb {

  struct Regex::private_t {
    std::string pattern;
    std::regex re;
    std::map<std::string, int> nameMap;   // empty: named groups unused by the core
    std::map<int, std::string> indexMap;

    explicit private_t(const std::string &p) :
      pattern(p), re(p, std::regex::ECMAScript) {}
  };


  Regex::Regex(const std::string &pattern, bool posix) :
    pri(new private_t(pattern)) {}


  std::string Regex::toString() const {return pri->pattern;}

  unsigned Regex::getGroupCount() const {
    return (unsigned)pri->re.mark_count();
  }

  const std::map<std::string, int> &Regex::getGroupNameMap() const {
    return pri->nameMap;
  }

  const std::map<int, std::string> &Regex::getGroupIndexMap() const {
    return pri->indexMap;
  }


  bool Regex::match(const std::string &s) const {
    return std::regex_match(s, pri->re);
  }


  bool Regex::search(const std::string &s) const {
    return std::regex_search(s, pri->re);
  }


  bool Regex::match(const std::string &s, Match &m) const {
    return match_or_search(true, s, m);
  }


  bool Regex::search(const std::string &s, Match &m) const {
    return match_or_search(false, s, m);
  }


  bool Regex::match_or_search(bool match, const std::string &s, Match &m) const {
    std::smatch sm;
    bool ok = match ? std::regex_match(s, sm, pri->re)
                    : std::regex_search(s, sm, pri->re);
    if (!ok) return false;

    m.clear();
    m.offsets.clear();
    for (unsigned i = 0; i < sm.size(); i++) {
      bool matched = sm[i].matched;
      m.push_back(matched ? sm[i].str() : std::string());
      m.offsets.push_back(matched ? (unsigned)sm.position(i) : (unsigned)-1);
    }

    return true;
  }


  std::string Regex::replace(const std::string &s, const std::string &r) const {
    return std::regex_replace(s, pri->re, r);
  }


  std::string Regex::escape(const std::string &s) {
    static const std::string special = ".^$|()[]{}*+?\\";
    std::string out;
    out.reserve(s.size());
    for (char c : s) {
      if (special.find(c) != std::string::npos) out += '\\';
      out += c;
    }
    return out;
  }
}
