################################################################################
#                                                                              #
#            CAMotics is an Open-Source simulation and CAM software.           #
#    Copyright (C) 2011-2021 Joseph Coffland <joseph@cauldrondevelopment.com>  #
#                                                                              #
#      This program is free software: you can redistribute it and/or modify    #
#      it under the terms of the GNU General Public License as published by    #
#       the Free Software Foundation, either version 2 of the License, or      #
#                      (at your option) any later version.                     #
#                                                                              #
#        This program is distributed in the hope that it will be useful,       #
#         but WITHOUT ANY WARRANTY; without even the implied warranty of       #
#         MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the        #
#                  GNU General Public License for more details.                #
#                                                                              #
#       You should have received a copy of the GNU General Public License      #
#     along with this program.  If not, see <http://www.gnu.org/licenses/>.    #
#                                                                              #
################################################################################

"""SCons.Tool.qt5

Tool-specific initialization for Qt5.

There normally shouldn't be any need to import this module directly.
It will usually be imported through the generic SCons.Tool.Tool()
selection method.

"""

# Copyright (c) 2001-7,2010,2011,2012 The SCons Foundation
#
# Permission is hereby granted, free of charge, to any person obtaining
# a copy of this software and associated documentation files (the
# "Software"), to deal in the Software without restriction, including
# without limitation the rights to use, copy, modify, merge, publish,
# distribute, sublicense, and/or sell copies of the Software, and to
# permit persons to whom the Software is furnished to do so, subject to
# the following conditions:
#
# The above copyright notice and this permission notice shall be included
# in all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
# KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
# WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
# NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
# LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
# OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
# WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import os.path
import re
import six
import subprocess

import SCons.Action
import SCons.Builder
import SCons.Defaults
import SCons.Scanner
import SCons.Tool
import SCons.Util


try:
    from SCons.Warnings import Warning as SConsWarning
except:
    from SCons.Warnings import SConsWarning


def _bytes_to_str(s):
    if isinstance(s, bytes): return s.decode()
    return s


class ToolQt5Warning(SConsWarning): pass
class GeneratedMocFileNotIncluded(ToolQt5Warning): pass
class QtdirNotFound(ToolQt5Warning): pass

SCons.Warnings.enableWarningClass(ToolQt5Warning)


try:
    sorted
except NameError:
    # Pre-2.4 Python has no sorted() function.
    #
    # The pre-2.4 Python list.sort() method does not support
    # list.sort(key=) nor list.sort(reverse=) keyword arguments, so
    # we must implement the functionality of those keyword arguments
    # by hand instead of passing them to list.sort().
    def sorted(iterable, cmp = None, key = None, reverse = 0):
        if key is not None: result = [(key(x), x) for x in iterable]
        else: result = iterable[:]

        # Pre-2.3 Python does not support list.sort(None).
        if cmp is None: result.sort()
        else: result.sort(cmp)

        if key is not None: result = [t1 for t0,t1 in result]
        if reverse: result.reverse()

        return result


qrcinclude_re = re.compile(r'<file[^>]*>([^<]*)</file>', re.M)
mocver_re = re.compile(r'.*(\d+)\.(\d+)\.(\d+).*')


def transformToWinePath(path):
    return os.popen('winepath -w "%s"'%path).read().strip().replace('\\','/')

header_extensions = [".h", ".hxx", ".hpp", ".hh"]
if SCons.Util.case_sensitive_suffixes('.h', '.H'):
    header_extensions.append('.H')
cxx_suffixes = [".c", ".cxx", ".cpp", ".cc"]


def checkMocIncluded(target, source, env):
    moc = target[0]
    cpp = source[0]
    # looks like cpp.includes is cleared before the build stage :-(
    # not really sure about the path transformations (moc.cwd? cpp.cwd?) :-/
    path = SCons.Defaults.CScan.path_function(env, moc.cwd)
    includes = SCons.Defaults.CScan(cpp, env, path)
    if not moc in includes:
        SCons.Warnings.warn(
            GeneratedMocFileNotIncluded,
            "Generated moc file '%s' is not included by '%s'" % (moc, cpp))


def find_file(filename, paths, node_factory):
    for dir in paths:
        node = node_factory(filename, dir)
        if node.rexists(): return node


class _Automoc:
    """
    Callable class, which works as an emitter for Programs, SharedLibraries and
    StaticLibraries.
    """

    def __init__(self, objBuilderName):
        self.objBuilderName = objBuilderName
        # some regular expressions:
        # Q_OBJECT detection
        self.qo_search = re.compile(r'[^A-Za-z0-9]Q_OBJECT[^A-Za-z0-9]')
        # cxx and c comment 'eater'
        self.ccomment = re.compile(r'/\*(.*?)\*/',re.S)
        self.cxxcomment = re.compile(r'//.*$',re.M)
        # we also allow Q_OBJECT in a literal string
        self.literal_qobject = re.compile(r'"[^\n]*Q_OBJECT[^\n]*"')


    def create_automoc_options(self, env):
        """
        Create a dictionary with variables related to Automocing,
        based on the current environment.
        Is executed once in the __call__ routine.
        """
        moc_options = {'auto_scan' : True,
                       'auto_scan_strategy' : 0,
                       'gobble_comments' : 0,
                       'debug' : 0,
                       'auto_cpppath' : True,
                       'cpppaths' : []}
        try:
            if int(env.subst('$QT5_AUTOSCAN')) == 0:
                moc_options['auto_scan'] = False
        except ValueError: pass

        try:
            moc_options['auto_scan_strategy'] = int(
                env.subst('$QT5_AUTOSCAN_STRATEGY'))
        except ValueError: pass

        try:
            moc_options['gobble_comments'] = int(
                env.subst('$QT5_GOBBLECOMMENTS'))
        except ValueError: pass

        try:
            moc_options['debug'] = int(env.subst('$QT5_DEBUG'))
        except ValueError: pass

        try:
            if int(env.subst('$QT5_AUTOMOC_SCANCPPPATH')) == 0:
                moc_options['auto_cpppath'] = False
        except ValueError: pass

        if moc_options['auto_cpppath']:
            paths = env.get('QT5_AUTOMOC_CPPPATH', [])
            if not paths: paths = env.get('CPPPATH', [])
            moc_options['cpppaths'].extend(paths)

        return moc_options


    def __automoc_strategy_simple(self, env, moc_options,
                                  cpp, cpp_contents, out_sources):
        """
        Default Automoc strategy (Q_OBJECT driven): detect a header file
        (alongside the current cpp/cxx) that contains a Q_OBJECT
        macro...and MOC it.
        If a Q_OBJECT macro is also found in the cpp/cxx itself,
        it gets MOCed too.
        """

        h = None
        for h_ext in header_extensions:
            # try to find the header file in the corresponding source
            # directory
            hname = self.splitext(cpp.name)[0] + h_ext
            h = find_file(hname, [cpp.get_dir()] +
                          moc_options['cpppaths'], env.File)
            if h:
                if moc_options['debug']:
                    print("scons: qt5: Scanning '%s' (header of '%s')" %
                          (h, cpp))
                h_contents = _bytes_to_str(h.get_contents())

                if moc_options['gobble_comments']:
                    h_contents = self.ccomment.sub('', h_contents)
                    h_contents = self.cxxcomment.sub('', h_contents)
                h_contents = self.literal_qobject.sub('""', h_contents)
                break

        if not h and moc_options['debug']:
            print("scons: qt5: no header for '%s'." % (cpp))

        if h and self.qo_search.search(h_contents):
            # h file with the Q_OBJECT macro found -> add moc_cpp
            moc_cpp = env.Moc5(h)
            if moc_options['debug']:
                print("scons: qt5: found Q_OBJECT macro in "
                      "'%s', mocing to '%s'" % (h, moc_cpp))

            # Now, check whether the corresponding CPP file
            # includes the moc'ed output directly...
            inc_moc_cpp = r'^\s*#\s*include\s+"%s"' % re.escape(str(moc_cpp[0]))

            if cpp and re.search(inc_moc_cpp, cpp_contents, re.M):
                if moc_options['debug']:
                    print("scons: qt5: CXX file '%s' directly includes the "
                          "moc'ed output '%s', no compiling required" %
                          (cpp, moc_cpp))
                env.Depends(cpp, moc_cpp)

            else:
                moc_o = self.objBuilder(moc_cpp)
                if moc_options['debug']:
                    print("scons: qt5: compiling '%s' to '%s'" % (cpp, moc_o))
                out_sources.extend(moc_o)

        if cpp and self.qo_search.search(cpp_contents):
            # cpp file with Q_OBJECT macro found -> add moc
            # (to be included in cpp)
            moc = env.Moc5(cpp)
            env.Ignore(moc, moc)
            if moc_options['debug']:
                print("scons: qt5: found Q_OBJECT macro in '%s', moc'ing "
                      "to '%s'" % (cpp, moc))


    def __automoc_strategy_include_driven(self, env, moc_options,
                                          cpp, cpp_contents, out_sources):
        """
        Automoc strategy #1 (include driven): searches for "include"
        statements of MOCed files in the current cpp/cxx file.
        This strategy tries to add support for the compilation
        of the qtsolutions...
        """
        if self.splitext(str(cpp))[1] in cxx_suffixes:
            added = False
            h_moc = "%s%s%s" % (
                env.subst('$QT5_XMOCHPREFIX'), self.splitext(cpp.name)[0],
                env.subst('$QT5_XMOCHSUFFIX'))
            cxx_moc = "%s%s%s" % (
                env.subst('$QT5_XMOCCXXPREFIX'), self.splitext(cpp.name)[0],
                env.subst('$QT5_XMOCCXXSUFFIX'))
            inc_h_moc = r'#include\s+"%s"' % h_moc
            inc_cxx_moc = r'#include\s+"%s"' % cxx_moc

            # Search for special includes in qtsolutions style
            if cpp and re.search(inc_h_moc, cpp_contents):
                # cpp file with #include directive for a MOCed header
                # found -> add moc

                # Try to find header file
                h = None
                hname = ""
                for h_ext in header_extensions:
                    # Try to find the header file in the
                    # corresponding source directory
                    hname = self.splitext(cpp.name)[0] + h_ext
                    h = find_file(hname, [cpp.get_dir()] +
                                  moc_options['cpppaths'], env.File)

                    if h:
                        if moc_options['debug']:
                            print("scons: qt5: Scanning '%s' (header of '%s')" %
                                  (h, cpp))

                        h_contents = _bytes_to_str(h.get_contents())
                        if moc_options['gobble_comments']:
                            h_contents = self.ccomment.sub('', h_contents)
                            h_contents = self.cxxcomment.sub('', h_contents)
                        h_contents = self.literal_qobject.sub('""', h_contents)
                        break

                if not h and moc_options['debug']:
                    print("scons: qt5: no header for '%s'." % (cpp))

                if h and self.qo_search.search(h_contents):
                    # h file with the Q_OBJECT macro found -> add moc_cpp
                    moc_cpp = env.XMoc5(h)
                    env.Ignore(moc_cpp, moc_cpp)
                    added = True
                    # Removing file from list of sources, because it is not to
                    # be compiled but simply included by the cpp/cxx file.
                    for idx, s in enumerate(out_sources):
                        if hasattr(s, "sources") and len(s.sources) > 0:
                            if str(s.sources[0]) == h_moc:
                                out_sources.pop(idx)
                                break

                    if moc_options['debug']:
                        print("scons: qt5: found Q_OBJECT macro in '%s', "
                              "moc'ing to '%s'" % (h, h_moc))

                elif moc_options['debug']:
                    print("scons: qt5: found no Q_OBJECT macro in '%s', but "
                          "a moc'ed version '%s' gets included in '%s'" %
                          (h, inc_h_moc, cpp.name))

            if cpp and re.search(inc_cxx_moc, cpp_contents):
                # cpp file with #include directive for a MOCed cxx file
                # found -> add moc
                if self.qo_search.search(cpp_contents):
                    moc = env.XMoc5(target = cxx_moc, source = cpp)
                    env.Ignore(moc, moc)
                    added = True

                    if moc_options['debug']:
                        print("scons: qt5: found Q_OBJECT macro in '%s', "
                              "moc'ing to '%s'" % (cpp, moc))
                elif moc_options['debug']:
                    print("scons: qt5: found no Q_OBJECT macro in '%s', "
                          "although a moc'ed version '%s' of itself gets "
                          "included" % (cpp.name, inc_cxx_moc))

            if not added:
                # Fallback to default Automoc strategy (Q_OBJECT driven)
                self.__automoc_strategy_simple(env, moc_options, cpp,
                                               cpp_contents, out_sources)


    def __call__(self, target, source, env):
        """
        Smart autoscan function. Gets the list of objects for the Program
        or Lib. Adds objects and builders for the special qt5 files.
        """
        moc_options = self.create_automoc_options(env)

        # some shortcuts used in the scanner
        self.splitext = SCons.Util.splitext
        self.objBuilder = getattr(env, self.objBuilderName)

        # FIXME: The following is kind of hacky to get builders working properly
        objBuilderEnv = self.objBuilder.env
        self.objBuilder.env = env
        mocBuilderEnv = env.Moc5.env
        env.Moc5.env = env
        xMocBuilderEnv = env.XMoc5.env
        env.XMoc5.env = env

        # make a deep copy for the result; MocH objects will be appended
        out_sources = source[:]

        for obj in source:
            if not moc_options['auto_scan']: break

            if isinstance(obj, six.string_types):
                print("scons: qt5: '%s' MAYBE USING AN OLD SCONS VERSION AND "
                      "NOT CONVERTED TO 'File'. Discarded." % obj)
                continue

            if not obj.has_builder():
                # binary obj file provided
                if moc_options['debug']:
                    print("scons: qt5: '%s' seems to be a binary. Discarded." %
                          obj)
                continue

            cpp = obj.sources[0]
            if not self.splitext(str(cpp))[1] in cxx_suffixes:
                if moc_options['debug']:
                    print("scons: qt5: '%s' is no cxx file. Discarded." % cpp)
                # c or fortran source
                continue

            try:
                cpp_contents = _bytes_to_str(cpp.get_contents())
                if moc_options['gobble_comments']:
                    cpp_contents = self.ccomment.sub('', cpp_contents)
                    cpp_contents = self.cxxcomment.sub('', cpp_contents)
                cpp_contents = self.literal_qobject.sub('""', cpp_contents)
            except: continue # may be an still not generated source

            if moc_options['auto_scan_strategy'] == 0:
                # Default Automoc strategy (Q_OBJECT driven)
                self.__automoc_strategy_simple(
                    env, moc_options, cpp, cpp_contents, out_sources)
            else:
                # Automoc strategy #1 (include driven)
                self.__automoc_strategy_include_driven(
                    env, moc_options, cpp, cpp_contents, out_sources)

        # restore the original env attributes (FIXME)
        self.objBuilder.env = objBuilderEnv
        env.Moc5.env = mocBuilderEnv
        env.XMoc5.env = xMocBuilderEnv

        # We return the set of source entries as sorted sequence, else
        # the order might accidentally change from one build to another
        # and trigger unwanted rebuilds. For proper sorting, a key function
        # has to be specified...FS.Entry (and Base nodes in general) do not
        # provide a __cmp__, for performance reasons.
        return (target, sorted(set(out_sources),
                               key = lambda entry : str(entry)))


AutomocShared = _Automoc('SharedObject')
AutomocStatic = _Automoc('StaticObject')


def _detect(env):
    """Not really safe, but fast method to detect the Qt5 library"""
    try: return env['QT5DIR']
    except KeyError: pass

    try: return env['QTDIR']
    except KeyError: pass

    try: return os.environ['QT5DIR']
    except KeyError: pass

    try: return os.environ['QTDIR']
    except KeyError: pass

    moc = env.WhereIs('moc-qt5') or env.WhereIs('moc5') or env.WhereIs('moc')
    if moc:
        p = subprocess.Popen('%s -v' % moc, shell = True,
                             stdout = subprocess.PIPE, close_fds = True)
        vernumber = p.stdout.read()
        if isinstance(vernumber, bytes): vernumber = vernumber.decode()
        vernumber = mocver_re.match(vernumber)

        if vernumber:
            vernumber = [int(x) for x in vernumber.groups()]
            if vernumber < [5, 0, 0]:
                vernumber = '.'.join([str(x) for x in vernumber])
                moc = None
                raise Exception("QT5DIR variable not defined, and detected "
                                "moc is for Qt %s" % vernumber)

        QT5DIR = os.path.dirname(os.path.dirname(moc))
        SCons.Warnings.warn(
            QtdirNotFound, "QT5DIR variable is not defined, using moc "
            "executable as a hint (QT5DIR=%s)" % QT5DIR)
        return QT5DIR

    raise SCons.Errors.StopError(QtdirNotFound,
                                 "Could not detect Qt 5 installation")
    return None


def __scanResources(node, env, path, arg):
    # Helper function for scanning .qrc resource files
    # I've been careful on providing names relative to the qrc file
    # If that was not needed this code could be simplified a lot
    def recursiveFiles(basepath, path) :
        result = []
        for item in os.listdir(os.path.join(basepath, path)) :
            itemPath = os.path.join(path, item)
            if os.path.isdir(os.path.join(basepath, itemPath)) :
                result += recursiveFiles(basepath, itemPath)
            else: result.append(itemPath)
        return result

    contents = _bytes_to_str(node.get_contents())
    includes = qrcinclude_re.findall(contents)
    qrcpath = os.path.dirname(node.path)
    dirs = [included for included in includes if
            os.path.isdir(os.path.join(qrcpath, included))]

    # dirs need to include files recursively
    for dir in dirs :
        includes.remove(dir)
        includes += recursiveFiles(qrcpath, dir)
    return includes


# Scanners
__qrcscanner = SCons.Scanner.Scanner(
    name = 'qrcfile', function = __scanResources, argument = None,
    skeys = ['.qrc'])


# Emitters
def __qrc_path(head, prefix, tail, suffix):
    if head:
        if tail: return os.path.join(head, "%s%s%s" % (prefix, tail, suffix))
        else: return "%s%s%s" % (prefix, head, suffix)

    else: return "%s%s%s" % (prefix, tail, suffix)


def __qrc_emitter(target, source, env):
    sourceBase, sourceExt = os.path.splitext(SCons.Util.to_String(source[0]))
    sHead = None
    sTail = sourceBase

    if sourceBase: sHead, sTail = os.path.split(sourceBase)

    t = __qrc_path(sHead, env.subst('$QT5_QRCCXXPREFIX'),
                   sTail, env.subst('$QT5_QRCCXXSUFFIX'))

    return t, source


# Action generators
def __moc_generator_from_h(source, target, env, for_signature):
    pass_defines = False

    try:
        if int(env.subst('$QT5_CPPDEFINES_PASSTOMOC')) == 1: pass_defines = True
    except ValueError: pass

    s = '$QT5_MOCFROMHFLAGS $QT5_MOCINCFLAGS -o $TARGET $SOURCE'

    if pass_defines: return '$QT5_MOC $QT5_MOCDEFINES ' + s
    else: return '$QT5_MOC ' + s


def __moc_generator_from_cxx(source, target, env, for_signature):
    pass_defines = False
    try:
        if int(env.subst('$QT5_CPPDEFINES_PASSTOMOC')) == 1: pass_defines = True
    except ValueError: pass

    if pass_defines:
        return ['$QT5_MOC $QT5_MOCDEFINES $QT5_MOCFROMCXXFLAGS '
                '$QT5_MOCINCFLAGS -o $TARGET $SOURCE',
                SCons.Action.Action(checkMocIncluded, None)]
    else:
        return ['$QT5_MOC $QT5_MOCFROMCXXFLAGS $QT5_MOCINCFLAGS -o $TARGET '
                '$SOURCE', SCons.Action.Action(checkMocIncluded, None)]


__mocx_generator_from_h = __moc_generator_from_h
__mocx_generator_from_cxx = __moc_generator_from_cxx


def __qrc_generator(source, target, env, for_signature):
    name_defined = False
    try:
        if env.subst('$QT5_QRCFLAGS').find('-name') >= 0:
            name_defined = True
    except ValueError:
        pass

    if name_defined: return '$QT5_RCC $QT5_QRCFLAGS $SOURCE -o $TARGET'
    else:
        qrc_suffix = env.subst('$QT5_QRCSUFFIX')
        src = str(source[0])
        head, tail = os.path.split(src)
        if tail: src = tail

        qrc_suffix = env.subst('$QT5_QRCSUFFIX')
        if src.endswith(qrc_suffix): qrc_stem = src[:-len(qrc_suffix)]
        else: qrc_stem = src

        return '$QT5_RCC $QT5_QRCFLAGS -name %s $SOURCE -o $TARGET' % qrc_stem


# Builders
__ts_builder = SCons.Builder.Builder(
        action = SCons.Action.Action('$QT5_LUPDATECOM','$QT5_LUPDATECOMSTR'),
        suffix = '.ts', source_factory = SCons.Node.FS.Entry)

__qm_builder = SCons.Builder.Builder(
        action = SCons.Action.Action('$QT5_LRELEASECOM','$QT5_LRELEASECOMSTR'),
        src_suffix = '.ts', suffix = '.qm')

__qrc_builder = SCons.Builder.Builder(
        action = SCons.Action.CommandGeneratorAction(
            __qrc_generator, {'cmdstr':'$QT5_QRCCOMSTR'}),
        source_scanner = __qrcscanner,
        src_suffix = '$QT5_QRCSUFFIX',
        suffix = '$QT5_QRCCXXSUFFIX',
        prefix = '$QT5_QRCCXXPREFIX',
        single_source = 1)

__ex_moc_builder = SCons.Builder.Builder(
        action = SCons.Action.CommandGeneratorAction(
            __moc_generator_from_h, {'cmdstr': '$QT5_MOCCOMSTR'}))

__ex_uic_builder = SCons.Builder.Builder(
        action = SCons.Action.Action('$QT5_UICCOM', '$QT5_UICCOMSTR'),
        src_suffix = '.ui')


# Wrappers (pseudo-Builders)
def Ts5(env, target, source=None, *args, **kw):
    """
    A pseudo-Builder wrapper around the LUPDATE executable of Qt5.
        lupdate [options] [source-file|path]... -ts ts-files
    """
    if not SCons.Util.is_List(target): target = [target]
    if not source: source = target[:]
    if not SCons.Util.is_List(source): source = [source]

    # Check QT5_CLEAN_TS and use NoClean() function
    clean_ts = False
    try:
        if int(env.subst('$QT5_CLEAN_TS')) == 1: clean_ts = True
    except ValueError: pass

    result = []
    for t in target:
        obj = __ts_builder.__call__(env, t, source, **kw)
        # Prevent deletion of the .ts file, unless explicitly specified
        if not clean_ts: env.NoClean(obj)

        # Always make our target "precious", such that it is not deleted
        # prior to a rebuild
        env.Precious(obj)

        # Add to resulting target list
        result.extend(obj)

    return result


def Qm5(env, target, source = None, *args, **kw):
    """
    A pseudo-Builder wrapper around the LRELEASE executable of Qt5.
        lrelease [options] ts-files [-qm qm-file]
    """
    if not SCons.Util.is_List(target): target = [target]
    if not source: source = target[:]
    if not SCons.Util.is_List(source): source = [source]

    result = []
    for t in target:
        result.extend(__qm_builder.__call__(env, t, source, **kw))

    return result


def Qrc5(env, target, source = None, *args, **kw):
    """
    A pseudo-Builder wrapper around the RCC executable of Qt5.
        rcc [options] qrc-files -o out-file
    """
    if not SCons.Util.is_List(target): target = [target]
    if not source: source = target[:]
    if not SCons.Util.is_List(source): source = [source]

    result = []
    for t, s in zip(target, source):
        result.extend(__qrc_builder.__call__(env, t, str(s), **kw))

    return result


def ExplicitMoc5(env, target, source, *args, **kw):
    """
    A pseudo-Builder wrapper around the MOC executable of Qt5.
        moc [options] <header-file>
    """
    if not SCons.Util.is_List(target): target = [target]
    if not SCons.Util.is_List(source): source = [source]

    result = []
    for t in target:
        # Is it a header or a cxx file?
        result.extend(__ex_moc_builder.__call__(env, t, source, **kw))

    return result


def ExplicitUic5(env, target, source, *args, **kw):
    """
    A pseudo-Builder wrapper around the UIC executable of Qt5.
        uic [options] <uifile>
    """
    if not SCons.Util.is_List(target): target = [target]
    if not SCons.Util.is_List(source): source = [source]

    result = []
    for t in target:
        result.extend(__ex_uic_builder.__call__(env, t, source, **kw))

    return result

def generate(env):
    """Add Builders and construction variables for qt5 to an Environment."""

    suffixes = ['-qt5', '-qt5.exe', '5', '5.exe', '', '.exe']
    command_suffixes = ['-qt5', '5', '']

    def locateQt5Command(env, command, qtdir) :
        triedPaths = []

        for suffix in suffixes :
            fullpath = os.path.join(qtdir, 'bin', command + suffix)
            if os.access(fullpath, os.X_OK) : return fullpath
            triedPaths.append(fullpath)

        fullpath = env.Detect([command + s for s in command_suffixes])
        if not (fullpath is None) : return fullpath

        raise Exception("Qt5 command '" + command + "' not found. Tried: " +
                        ', '.join(triedPaths))

    CLVar = SCons.Util.CLVar
    Action = SCons.Action.Action
    Builder = SCons.Builder.Builder

    version = tuple(map(int, SCons.__version__.split('.')))

    QT5_MOCDEFINES = \
        '${_defines(QT5_MOCDEFPREFIX, CPPDEFINES, QT5_MOCDEFSUFFIX, __env__'
    if (4, 2, 0) <= version: QT5_MOCDEFINES += ', TARGET, SOURCE'
    QT5_MOCDEFINES += ')}'

    env['QT5DIR'] = _detect(env)
    env.Replace(
        QT5DIR  = _detect(env),
        QT5_BINPATH = os.path.join('$QT5DIR', 'bin'),
        # TODO: This is not reliable to QT5DIR value changes but needed in
        # order to support '-qt5' variants
        QT5_MOC = locateQt5Command(env,'moc', env['QT5DIR']),
        QT5_UIC = locateQt5Command(env,'uic', env['QT5DIR']),
        QT5_RCC = locateQt5Command(env,'rcc', env['QT5DIR']),
        QT5_LUPDATE = locateQt5Command(env,'lupdate', env['QT5DIR']),
        QT5_LRELEASE = locateQt5Command(env,'lrelease', env['QT5DIR']),

        # Should the qt5 tool try to figure out, which sources are to be moc'ed?
        QT5_AUTOSCAN = 1,
        # While scanning for files to moc, should we search for includes in
        # qtsolutions style?
        QT5_AUTOSCAN_STRATEGY = 0,
        # If set to 1, comments are removed before scanning cxx/h files.
        QT5_GOBBLECOMMENTS = 0,
        # If set to 1, all CPPDEFINES get passed to the moc executable.
        QT5_CPPDEFINES_PASSTOMOC = 1,
        # If set to 1, translation files (.ts) get cleaned on 'scons -c'
        QT5_CLEAN_TS = 0,
        # If set to 1, the CPPPATHs (or QT5_AUTOMOC_CPPPATH) get scanned for
        # moc'able files
        QT5_AUTOMOC_SCANCPPPATH = 1,
        # Alternative paths that get scanned for moc files
        QT5_AUTOMOC_CPPPATH = [],

        # Some Qt5 specific flags.  I don't expect someone wants to manipulate
        # those ...
        QT5_UICFLAGS = CLVar(''),
        QT5_MOCFROMHFLAGS = CLVar(''),
        QT5_MOCFROMCXXFLAGS = CLVar('-i'),
        QT5_QRCFLAGS = '',
        QT5_LUPDATEFLAGS = '',
        QT5_LRELEASEFLAGS = '',

        # suffixes/prefixes for the headers / sources to generate
        QT5_UISUFFIX = '.ui',
        QT5_UICDECLPREFIX = 'ui_',
        QT5_UICDECLSUFFIX = '.h',
        QT5_MOCINCPREFIX = '-I',
        QT5_MOCHPREFIX = 'moc_',
        QT5_MOCHSUFFIX = '$CXXFILESUFFIX',
        QT5_MOCCXXPREFIX = '',
        QT5_MOCCXXSUFFIX = '.moc',
        QT5_QRCSUFFIX = '.qrc',
        QT5_QRCCXXSUFFIX = '$CXXFILESUFFIX',
        QT5_QRCCXXPREFIX = 'qrc_',
        QT5_MOCDEFPREFIX = '-D',
        QT5_MOCDEFSUFFIX = '',
        QT5_MOCDEFINES = QT5_MOCDEFINES,
        QT5_MOCCPPPATH = [],
        QT5_MOCINCFLAGS = '$( ${_concat(QT5_MOCINCPREFIX, QT5_MOCCPPPATH, '
        'INCSUFFIX, __env__, RDirs)} $)',

        # Commands for the qt5 support ...
        QT5_UICCOM = '$QT5_UIC $QT5_UICFLAGS -o $TARGET $SOURCE',
        QT5_LUPDATECOM = '$QT5_LUPDATE $QT5_LUPDATEFLAGS $SOURCES -ts $TARGET',
        QT5_LRELEASECOM = '$QT5_LRELEASE $QT5_LRELEASEFLAGS -qm $TARGET '
        '$SOURCES',

        # Specialized variables for the Extended Automoc support
        # (Strategy #1 for qtsolutions)
        QT5_XMOCHPREFIX = 'moc_',
        QT5_XMOCHSUFFIX = '.cpp',
        QT5_XMOCCXXPREFIX = '',
        QT5_XMOCCXXSUFFIX = '.moc',
    )

    try:
        env.AddMethod(Ts5, "Ts5")
        env.AddMethod(Qm5, "Qm5")
        env.AddMethod(Qrc5, "Qrc5")
        env.AddMethod(ExplicitMoc5, "ExplicitMoc5")
        env.AddMethod(ExplicitUic5, "ExplicitUic5")

    except AttributeError:
        # Looks like we use a pre-0.98 version of SCons...
        from SCons.Script.SConscript import SConsEnvironment
        SConsEnvironment.Ts5 = Ts5
        SConsEnvironment.Qm5 = Qm5
        SConsEnvironment.Qrc5 = Qrc5
        SConsEnvironment.ExplicitMoc5 = ExplicitMoc5
        SConsEnvironment.ExplicitUic5 = ExplicitUic5

    # Interface builder
    uic5builder = Builder(
        action = SCons.Action.Action('$QT5_UICCOM', '$QT5_UICCOMSTR'),
        src_suffix = '$QT5_UISUFFIX',
        suffix = '$QT5_UICDECLSUFFIX',
        prefix = '$QT5_UICDECLPREFIX',
        single_source = True
        # TODO: Consider the uiscanner on new scons version
    )
    env['BUILDERS']['Uic5'] = uic5builder

    # Metaobject builder
    mocBld = Builder(action = {}, prefix = {}, suffix = {})
    for h in header_extensions:
        act = SCons.Action.CommandGeneratorAction(
            __moc_generator_from_h, {'cmdstr':'$QT5_MOCCOMSTR'})
        mocBld.add_action(h, act)
        mocBld.prefix[h] = '$QT5_MOCHPREFIX'
        mocBld.suffix[h] = '$QT5_MOCHSUFFIX'

    for cxx in cxx_suffixes:
        act = SCons.Action.CommandGeneratorAction(
            __moc_generator_from_cxx, {'cmdstr':'$QT5_MOCCOMSTR'})
        mocBld.add_action(cxx, act)
        mocBld.prefix[cxx] = '$QT5_MOCCXXPREFIX'
        mocBld.suffix[cxx] = '$QT5_MOCCXXSUFFIX'
    env['BUILDERS']['Moc5'] = mocBld

    # Metaobject builder for the extended auto scan feature
    # (Strategy #1 for qtsolutions)
    xMocBld = Builder(action = {}, prefix = {}, suffix = {})
    for h in header_extensions:
        act = SCons.Action.CommandGeneratorAction(
            __mocx_generator_from_h, {'cmdstr':'$QT5_MOCCOMSTR'})
        xMocBld.add_action(h, act)
        xMocBld.prefix[h] = '$QT5_XMOCHPREFIX'
        xMocBld.suffix[h] = '$QT5_XMOCHSUFFIX'

    for cxx in cxx_suffixes:
        act = SCons.Action.CommandGeneratorAction(
            __mocx_generator_from_cxx, {'cmdstr':'$QT5_MOCCOMSTR'})
        xMocBld.add_action(cxx, act)
        xMocBld.prefix[cxx] = '$QT5_XMOCCXXPREFIX'
        xMocBld.suffix[cxx] = '$QT5_XMOCCXXSUFFIX'
    env['BUILDERS']['XMoc5'] = xMocBld

    # Add the Qrc5 action to the CXX file builder (registers the
    # *.qrc extension with the Environment)
    cfile_builder, cxxfile_builder = SCons.Tool.createCFileBuilders(env)
    qrc_act = SCons.Action.CommandGeneratorAction(
        __qrc_generator, {'cmdstr':'$QT5_QRCCOMSTR'})
    cxxfile_builder.add_action('$QT5_QRCSUFFIX', qrc_act)
    cxxfile_builder.add_emitter('$QT5_QRCSUFFIX', __qrc_emitter)

    # We use the emitters of Program / StaticLibrary / SharedLibrary
    # to scan for moc'able files
    # We can't refer to the builders directly, we have to fetch them
    # as Environment attributes because that sets them up to be called
    # correctly later by our emitter.
    env.AppendUnique(
        PROGEMITTER = [AutomocStatic], SHLIBEMITTER = [AutomocShared],
        LIBEMITTER  = [AutomocStatic])

    # TODO: Does dbusxml2cpp need an adapter
    try:
        env.AddMethod(enable_modules, "EnableQt5Modules")

    except AttributeError:
        # Looks like we use a pre-0.98 version of SCons...
        from SCons.Script.SConscript import SConsEnvironment
        SConsEnvironment.EnableQt5Modules = enable_modules


def enable_modules(self, modules, debug = False, crosscompiling = False) :
    import sys

    validModules = [
        # Qt Essentials
        'QtCore',
        'QtGui',
        'QtMultimedia',
        'QtMultimediaQuick_p',
        'QtMultimediaWidgets',
        'QtNetwork',
        'QtPlatformSupport',
        'QtQml',
        'QtQmlDevTools',
        'QtQuick',
        'QtQuickParticles',
        'QtSql',
        'QtQuickTest',
        'QtTest',
        'QtWebKit',
        'QtWebKitWidgets',
        'QtWebSockets',
        'QtWidgets',
        # Qt Add-Ons
        'QtConcurrent',
        'QtDBus',
        'QtOpenGL',
        'QtPrintSupport',
        'QtDeclarative',
        'QtScript',
        'QtScriptTools',
        'QtSvg',
        'QtUiTools',
        'QtXml',
        'QtXmlPatterns',
        # Qt Tools
        'QtHelp',
        'QtDesigner',
        'QtDesignerComponents',
        # Other
        'QtCLucene',
        'QtConcurrent',
        'QtV8'
    ]

    pclessModules = []
    staticModules = []
    invalidModules = []

    for module in modules:
        if module not in validModules: invalidModules.append(module)

    if invalidModules:
        raise Exception("Modules %s are not Qt5 modules. Valid Qt5 modules "
                        "are: %s" % (invalidModules, validModules))

    moduleDefines = {
        'QtScript'   : ['QT_SCRIPT_LIB'],
        'QtSvg'      : ['QT_SVG_LIB'],
        'QtSql'      : ['QT_SQL_LIB'],
        'QtXml'      : ['QT_XML_LIB'],
        'QtOpenGL'   : ['QT_OPENGL_LIB'],
        'QtGui'      : ['QT_GUI_LIB'],
        'QtNetwork'  : ['QT_NETWORK_LIB'],
        'QtCore'     : ['QT_CORE_LIB'],
        'QtWidgets'  : ['QT_WIDGETS_LIB'],
    }

    for module in modules :
        try : self.AppendUnique(CPPDEFINES=moduleDefines[module])
        except: pass

    debugSuffix = ''
    if sys.platform in ["darwin", "linux2", "linux"] and not crosscompiling:
        if debug : debugSuffix = '_debug'
        for module in modules :
            if module not in pclessModules : continue
            self.AppendUnique(LIBS = [module.replace('Qt','Qt5') + debugSuffix])
            self.AppendUnique(LIBPATH = [os.path.join("$QT5DIR", "lib")])
            self.AppendUnique(CPPPATH = [os.path.join("$QT5DIR", "include")])
            self.AppendUnique(
                CPPPATH = [os.path.join("$QT5DIR", "include", module)])

        pcmodules = [module.replace('Qt', 'Qt5') + debugSuffix
                     for module in modules if module not in pclessModules]

        if 'Qt5DBus' in pcmodules:
            self.AppendUnique(
                CPPPATH = [os.path.join("$QT5DIR", "include", "Qt5DBus")])

        if "Qt5Assistant" in pcmodules:
            self.AppendUnique(
                CPPPATH = [os.path.join("$QT5DIR", "include", "Qt5Assistant")])
            pcmodules.remove("Qt5Assistant")
            pcmodules.append("Qt5AssistantClient")

        self.AppendUnique(RPATH = [os.path.join("$QT5DIR", "lib")])
        self.ParseConfig('pkg-config %s --libs --cflags' % ' '.join(pcmodules))
        self["QT5_MOCCPPPATH"] = self["CPPPATH"]
        return

    if sys.platform == "win32" or crosscompiling:
        if crosscompiling:
            transformedQtdir = transformToWinePath(self['QT5DIR'])
            self['QT5_MOC'] = "QT5DIR=%s %s" % (
                transformedQtdir, self['QT5_MOC'])

        self.AppendUnique(CPPPATH = [os.path.join("$QT5DIR","include")])
        try: modules.remove("QtDBus")
        except: pass

        if debug : debugSuffix = 'd'

        if "QtAssistant" in modules:
            self.AppendUnique(
                CPPPATH = [os.path.join("$QT5DIR", "include", "QtAssistant")])
            modules.remove("QtAssistant")
            modules.append("QtAssistantClient")

        self.AppendUnique(LIBS = ['qtmain' + debugSuffix])
        self.AppendUnique(
            LIBS = [lib.replace("Qt","Qt5") + debugSuffix
                    for lib in modules if lib not in staticModules])
        self.PrependUnique(LIBS = [lib + debugSuffix
                                   for lib in modules if lib in staticModules])

        if 'QtOpenGL' in modules: self.AppendUnique(LIBS = ['opengl32'])
        self.AppendUnique(CPPPATH = ['$QT5DIR/include/'])
        self.AppendUnique(CPPPATH = ['$QT5DIR/include/' + module
                                     for module in modules])

        if crosscompiling :
            self["QT5_MOCCPPPATH"] = [
                path.replace('$QT5DIR', transformedQtdir)
                    for path in self['CPPPATH'] ]

        else: self["QT5_MOCCPPPATH"] = self["CPPPATH"]
        self.AppendUnique(LIBPATH = [os.path.join('$QT5DIR','lib')])


def exists(env): return _detect(env)
